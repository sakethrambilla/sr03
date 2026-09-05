# Subagent observation

## Problem

A turn that delegates shows nothing worth looking at. When the agent spawns a subagent, the
child's messages and tool calls arrive tagged as belonging to that child, and sr03 drops the tag
and folds them straight into the main transcript — so a delegating turn reads as one agent doing
everything at once, with tool calls interleaved in an order that never happened. The thread already
tracks each subagent as a row with a token count, a tool count and the name of the last tool, but
that is a heartbeat, not a view: it tells you something is running and nothing at all about what.
The only way to find out what a subagent actually did is to wait for it to finish and read the
summary it hands back.

## Goal

A subagent a turn spawns can be opened as its own tab that shows what it is doing while it does
it, and can be stopped from there — and its activity stops contaminating the parent's transcript.

## Non-goals

- **Talking to a subagent.** No composer, no steering, no follow-up instructions. Sending a message
  to a running child is a separate decision with its own design risk, and nothing here should
  prejudge it.
- **Resuming a finished subagent.** Related to the above and deferred with it.
- **Surviving a restart.** A subagent tab renders from what this session captured. Closing the app,
  or parking the thread for long enough to lose the process, is allowed to lose the detail.
- **A subagent transcript for Cursor.** Cursor's protocol carries no child stream. This is a fixed
  external constraint, not a corner being cut, and the Cursor case is designed for explicitly
  rather than left broken.
- **A tree view.** Subagents can nest several layers deep. They are listed flat in start order,
  with depth shown as a value, not as indentation or an expandable hierarchy.
- **Changing how approvals work.** A permission prompt raised from inside a subagent keeps
  surfacing exactly where it surfaces today.
- **A setting for any of this.** No toggle for message forwarding, no per-thread opt-in.

## Behaviour

**Watching one.** While a turn runs, every subagent it spawns is listed with its type, the task it
was given, and its status. Opening one gives it a tab of its own, alongside the transcript and any
open files, showing that child's own work as it happens: its messages, its reasoning, and each tool
it calls, streaming in the same shapes the main transcript already uses. A running subagent's tab
carries a stop control; a finished one shows its final report, how long it took, and what it spent.

**The parent's transcript.** Delegated work no longer appears inline. In place of the child's
scattered messages the transcript carries one row for the delegation itself — what was delegated,
to which kind of agent, and whether it is still running — which is the thing to click to open the
tab. What the parent says about the result afterwards is unchanged.

**Living with the tabs.** A subagent tab behaves like any other tab: it can be closed, and it can
be reopened from the list. Closing it does not stop the subagent, and stopping a subagent does not
close its tab — a stopped child keeps whatever it produced before it stopped, marked as stopped.
Several subagents running at once means several tabs, and they can be arranged across split groups
like anything else.

**Cursor.** Cursor announces a subagent with the task description, the kind of agent, the model,
and — when it finishes — how long it took, and nothing more. A Cursor subagent is listed with the
same information as a Claude one and opens the same tab, but that tab shows the delegation's
details and its final result rather than a transcript, and says plainly that Cursor does not
publish the child's activity. It is a card that explains itself, not an empty transcript that looks
broken.

**When things go wrong.** A subagent that fails shows its error where its result would go, and its
row is marked failed rather than silently disappearing. A subagent still running when its thread is
parked keeps its tab, showing what was captured up to the park, marked as no longer live. A subagent
that produced nothing before it ended shows that it produced nothing, rather than an empty tab that
is indistinguishable from one that failed to render.

## Acceptance criteria

1. When a Claude turn spawns a subagent, a row for it appears with the subagent's type and the task
   description, and the row's status reads running until the subagent settles.
2. When that row is opened, a tab appears containing the subagent's own messages and tool calls, and
   those same messages and tool calls do not appear in the parent's transcript.
3. When the subagent writes text while its tab is open, that text streams into the tab without a
   reload.
4. When the subagent finishes, its tab shows its final report, its row's status reads done, and the
   row shows the duration.
5. When the stop control on a running subagent's tab is used, the subagent stops, its row's status
   reads stopped, and its tab still shows everything captured before the stop.
6. When a subagent's tab is closed and its row is opened again, the tab returns with the same
   content it had.
7. When a subagent fails, its tab shows the error text and its row reads failed.
8. When a turn spawns three subagents at once, three rows appear and each opens its own tab.
9. When a subagent spawns a subagent of its own, both appear as rows in the same flat list, and the
   deeper one records a greater depth.
10. When a Cursor turn spawns a subagent, a row appears carrying the description, the subagent type
    and the model, and on completion the duration reported by Cursor.
11. When that Cursor row is opened, the tab states that Cursor publishes no transcript for
    subagents, and shows the delegation's details and final result instead of an empty transcript.
12. When a thread with a running subagent is parked, the subagent's tab remains open showing what
    was captured, marked as no longer live, and the app does not error.
13. When a turn spawns no subagents, the transcript and the tab strip are indistinguishable from
    how they render today.

## Constraints

- The child's messages reach us only because each one is tagged with the tool call that spawned it.
  That tag is the sole linkage available; there is no separate channel and no child session to
  attach to.
- Claude forwards a subagent's text and reasoning only when explicitly asked to. Left at its
  default it forwards tool calls alone, which is not enough to render a transcript, so the request
  for full forwarding is a hard requirement of this feature rather than an enhancement.
- Cursor's protocol has no concept of a child agent: no parent linkage on updates, no nested
  stream, no capability advertised for one. Everything Cursor publishes about a subagent arrives in
  a single one-way notification. No amount of client work changes this, and the design must not
  assume it will.
- Cursor's notification already carries the subagent's type and its duration; both are currently
  discarded. Capturing them is part of this change.
- Wire event types exist twice, once on the server and once mirrored on the web, and must move
  together in the same change.
- The dependency budget stands. The tab, the list and the card are composed from the UI components
  already in the project; nothing new is added to render them.
- Subagent rows are a list held per thread, and the client's selectors must not build that list
  fresh on each read, which would loop the renderer.
- Any keyboard shortcut this adds is recorded in the project's shortcut reference in the same
  change.
- Neither provider's turn handling is considered working until a real turn has been run through it
  against a scratch repository.

## Open questions

- Whether the delegation row in the parent's transcript should also expand in place, as well as
  opening a tab — proceeding with open-a-tab only, since two ways to read the same thing doubles
  the rendering work for no decision the user has to make.
- What a subagent tab should do when its thread is rewound past the turn that spawned it —
  proceeding by closing the tab and dropping the row, on the grounds that the delegation no longer
  exists in the conversation and a tab pointing at nothing is worse than no tab.
- Whether a subagent's token spend should be shown in the tab as well as the row — proceeding with
  the row only, since the row is where the other per-subagent totals already live.
