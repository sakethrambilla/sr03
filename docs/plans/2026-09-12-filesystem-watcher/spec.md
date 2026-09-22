# Filesystem watcher

## Problem

The app never actually watches the filesystem. It infers that files changed by looking at the
agent's tool messages — if a turn used a write tool, the tree is told to refresh. Everything
else is invisible: a command run in the terminal panel, a file saved in the user's own editor,
a branch switch or a stash pop performed from the worktree panel, a build that regenerates
output. The tree silently shows the past until the next agent turn happens to write something.

The inference is also debounced with a trailing timer and no upper bound, so a turn that writes
continuously keeps pushing the refresh further out. During a long refactor the tree can stay
stale for the whole turn and then update once at the end.

## Goal

The tree learns about filesystem changes from the filesystem, promptly and at a bounded rate,
regardless of what caused them.

## Non-goals

- **Watching anything other than a session's working directory.** Not the whole project, not
  other sessions' worktrees, not paths outside the session root.
- **Reporting *what* changed.** A change signal says "something under this session changed", and
  optionally which directory. Consumers decide what to re-read. Path-level diffing is not part
  of this.
- **Replacing git status polling.** The change set keeps its current trigger. It gains a minimum
  interval, because a faster change signal must not turn into a faster `git status` — but nothing
  else about how or when it runs changes.
- **A new dependency.** Node's built-in recursive watch is the mechanism.
- **Remote or SSH watching.** Local sessions only.
- **Surviving a missed event through reconciliation.** If the platform drops or overflows events,
  the correct response is a full refresh signal, not a reconstruction of what was missed.
- **Changing what consumers do with the signal.** The file tree's behaviour on refresh is the
  file tree spec's concern.

## Behaviour

**Normal operation.** While at least one client is looking at a session, the server watches that
session's working directory. Changes under it produce a change signal on the existing event bus,
which reaches every connected client.

**Bursts.** Signals are coalesced. After the first change, the server waits for a short quiet
period before emitting; if changes keep arriving, it emits anyway once a maximum wait has
elapsed, so sustained churn cannot starve the signal. A build touching ten thousand files
produces a steady trickle of signals, not ten thousand, and not one at the very end.

**Noise.** Changes inside the git internals directory do not produce signals — that directory is
the one path the tree never shows. Nothing else is filtered: `node_modules` and other ignored
paths are visible in the tree, so dropping their events would under-signal a directory the user
can see. A watcher that cannot filter cheaply enough may over-signal, but must never under-signal.

**Lifecycle.** The watcher starts when a session first needs it and stops when nothing is
watching, so an idle app holds no watches. A session whose directory is deleted or becomes
unreadable stops watching and does not retry in a loop.

**Overflow and failure.** If the platform reports that it lost events, or the watch fails to
start, the server emits a change signal anyway — a spurious refresh is cheap, a missed one is
not — and logs it. A failed watch degrades to the existing behaviour rather than breaking the
session.

**Replacing the inference.** Once the watcher is the source of truth, the tool-message inference
is removed rather than kept alongside it, so a single write does not produce two refreshes.

## Acceptance criteria

1. When a file under a session's working directory is created, modified, or deleted by any
   process, a change signal for that session reaches connected clients.
2. When changes arrive continuously, signals are emitted no more often than once per quiet
   period and no less often than once per maximum wait.
3. When a single change occurs after a period of quiet, the signal is emitted after the quiet
   period and not later.
4. When a change occurs only inside the git internals directory, no change signal is emitted.
5. When no client is watching a session, that session's working directory is not being watched.
   When a client's socket drops and reconnects, watching resumes without user action.
6. When a watch cannot be established, the session continues to function, the failure is logged
   once rather than per attempt, and no watch retry loop runs.
7. When the platform reports dropped or overflowed events, a change signal is emitted.
8. When a session is deleted, its directory becomes unreadable, or its worktree is about to be
   removed, its watch is released before the removal runs and no further signals are emitted for it.
9. When the agent writes files during a turn, exactly one refresh path fires — the watcher —
   and the tool-message inference no longer produces its own signal.

## Constraints

- **No new dependencies.** Node built-ins only, consistent with the server's existing budget.
- The signal travels on the existing in-process bus and existing WebSocket fan-out. No new
  message transport.
- The quiet period and maximum wait are defined once, as named constants, and are the same
  numbers the client-side coalescing uses if it ever needs them.
- Recursive watching is not available on every platform Node supports. Where it is unavailable,
  the feature degrades to the current behaviour rather than failing the session.
- Must not hold a watch on a worktree that the app is about to remove, since an open handle can
  block removal.

## Open questions

- **Quiet period and maximum wait** — proceeding on 150ms and 500ms, matching Orca, which shares
  one window between its server-side batcher and its client-side scheduler.
- **Ignore filtering depth** — proceeding on a prefix check against the git internals directory
  only. Consulting the repository's ignore rules per event would mean a subprocess per change,
  which defeats the purpose, and filtering `node_modules` would under-signal a directory the tree
  actually renders. So an install storm does produce signals — bounded by the coalescing window to
  one per maximum wait, which is the rate the tree already refreshes at.

- **Change-set minimum interval** — proceeding on 1000ms, so a build cannot drive `git status`
  at the 500ms signal rate. The tree listing still refreshes at the full signal rate; only the
  change set is floored.
- **Whether one watch per session or one per project root** — proceeding on one per session
  working directory, since sessions in separate worktrees have separate roots and sharing would
  cross-signal them.
