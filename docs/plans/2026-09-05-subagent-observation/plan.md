# Subagent observation — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch:** `feat/subagent-observation`
**Test command:** `pnpm test`
**Lint / typecheck:** `pnpm typecheck`
**Manual harness:** a scratch repo, never a real project —
`mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main && echo hello > README.md && git add . && git commit -qm init`

## Approach

**A subagent's output is stored as ordinary messages carrying `meta.taskId`.** Not a parallel
channel, not a second table, not an in-memory side buffer. `Message.meta` already exists and
already carries per-message structure (`toolName`, `toolUseId`, `input`, `result`), and
`messagesByThread` is already one flat array per thread on the client. So the subagent tab and the
main transcript are two filters over one list: the transcript drops every message with a `taskId`,
the tab keeps only its own. This is what buys criterion 6 — closing and reopening a tab needs no
work, because nothing was ever held in the tab. It also means rewind is already correct:
`thread.truncated` clears both the message list and `tasksByThread`
([store.ts:789](../../../web/src/store.ts:789)), which is exactly the open question's assumption.

**The correlation key is `tool_use_id`.** `task_started` carries an optional `tool_use_id`
identifying the Agent tool call that spawned the subagent, and every message produced inside that
subagent carries the same value as `parent_tool_use_id` — on `assistant`, on `user`, and on
`stream_event`. The Claude adapter keeps a `toolUseId → taskId` map built as tasks start, and
stamps `taskId` on the events it emits. `tool_use_id` is optional in the SDK's own type, so an
unmapped `parent_tool_use_id` **falls back to today's behaviour** and lands in the main transcript.
A subagent message must never be dropped for want of a mapping — a thinner transcript is a
regression a reviewer will catch, a silently missing message is not.

**`taskId` rides on the existing `AgentEvent` variants.** Four of them grow an optional field
rather than the boundary growing a second vocabulary for delegated work. The one place that needs
genuinely new wire events is streaming text: `thread.delta` feeds a single per-thread buffer
(`streamByThread`) that the composer renders, so subagent deltas pushed through it would type the
child's words into the parent's transcript. Those get `thread.task.delta` / `thread.task.delta.end`
and a `streamByTask` buffer keyed by task.

**Cursor needs no new task shape.** `cursor/task` is registered exactly like `cursor/ask_question`
([cursor.ts:777](../../../server/src/agents/cursor.ts:777)) and its payload maps onto the existing
`ThreadTask`: `subagentType → agentType`, and `durationMs` becomes `endedAt = startedAt +
durationMs` rather than a new field, so one renderer serves both providers. Only `model` is
genuinely new on the row.

**A new capability decides transcript-or-card.** `ProviderCapabilities.subagentTranscripts` is true
for Claude and false for Cursor. The client must branch on the capability, never on `providerId` —
that is the existing convention in this file and it is what keeps the Cursor card from becoming a
special case scattered through the view.

Order matters: Cursor first because it is small and unit-testable and proves the row shape carries
both providers; then Claude's routing, which is the risky part; then stop; then the client. The app
works after every task — after task 2 subagent messages are correctly quarantined out of the
transcript with no tab yet to read them in, which is a deliberate half-step, not a broken state.

## Global constraints

- **No new dependencies.** The view is composed from `components/ui` and `components/ui.tsx`.
- **Wire types move together.** `server/src/types.ts` and `web/src/lib/types.ts` are mirrors; a
  change to one without the other in the same commit is a defect.
- Server TS is type-stripped: no enums, no parameter properties, explicit `.ts` imports.
- UI comes from shadcn/ui, icons from `lucide-react` aliased in `components/ui.tsx`. No hand-drawn
  SVG, no text characters standing in for icons.
- Colors are the shadcn token set only. Radii: `rounded-md` interactive, `rounded-lg` panels,
  `rounded-full` only for dots.
- **Zustand selectors must not build a fresh array.** Every new per-thread or per-task list uses a
  module-level empty constant, as `AgentsPanel.tsx:9` already does. An inline `?? []` loops the
  renderer.
- **`streamByThread` must never receive subagent text.** This is the single easiest thing to get
  wrong and it looks like a rendering glitch rather than a routing bug.
- Neither provider is done until a real turn has run through it against `/tmp/sr03-repo`.
- Any keyboard shortcut added gets its row in `SHORTCUTS.md` in the same commit. This plan adds
  none; if execution introduces one, that rule applies.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/types.ts` | Modify | `model` on `ThreadTask`; `subagentTranscripts` capability; `thread.task.delta` / `.end` events |
| `server/src/models.ts` | Modify | Cursor `tasks: true`; `subagentTranscripts` on both providers |
| `server/src/agents/cursor.ts` | Modify | `cursor/task` request handler → `tasks.changed` |
| `server/src/agents/cursor.test.ts` | Modify | Coverage for the notification → task mapping |
| `server/src/agents/types.ts` | Modify | Optional `taskId` on four `AgentEvent` variants; `stopTask` on `AgentSession` |
| `server/src/agents/claude.ts` | Modify | `forwardSubagentText`; `toolUseId → taskId` map; stamp `taskId`; implement `stopTask` |
| `server/src/agents/runtime.ts` | Modify | Route task-stamped events to `meta.taskId` and task deltas; export `stopTask` |
| `server/src/api.ts` | Modify | `POST /api/threads/:id/tasks/:taskId/stop` |
| `web/src/lib/types.ts` | Modify | Mirror of all of the above; `EditorTab` gains `subagent` |
| `web/src/lib/layout.ts` | Modify | `tabKey` handles the subagent tab |
| `web/src/lib/layout.test.ts` | Modify | Key uniqueness and close/move for a subagent tab |
| `web/src/lib/api.ts` | Modify | `stopTask(threadId, taskId)` |
| `web/src/store.ts` | Modify | `streamByTask`; task delta events; drop tabs for vanished tasks |
| `web/src/components/EditorGroups.tsx` | Modify | `onClose` takes a tab, not a path; subagent tab chip |
| `web/src/components/ChatView.tsx` | Modify | Third branch in the tab body list; open-a-subagent action |
| `web/src/components/SubagentView.tsx` | Create | The tab body: transcript for Claude, card for Cursor |
| `web/src/components/Timeline.tsx` | Modify | Filter out task-stamped messages; delegation row that opens the tab |
| `web/src/components/AgentsPanel.tsx` | Modify | Rows open a tab; stop control; `model` on the row |
| `CLAUDE.md` | Modify | One line for `SubagentView.tsx` in Layout; a Cursor gotcha for `cursor/task` |

## Tasks

1. [tasks/01-cursor-task-notification.md](tasks/01-cursor-task-notification.md) — `cursor/task` → task rows, with tests
2. [tasks/02-claude-subagent-routing.md](tasks/02-claude-subagent-routing.md) — forwarding, correlation, task-scoped messages and deltas
3. [tasks/03-stop-a-subagent.md](tasks/03-stop-a-subagent.md) — `stopTask` through the boundary and out as a route
4. [tasks/04-client-tab-model.md](tasks/04-client-tab-model.md) — types, `tabKey`, store, tab plumbing, with tests
5. [tasks/05-subagent-view.md](tasks/05-subagent-view.md) — the view, the transcript filter, the panel wiring

Tasks 1, 2 and 3 are server-only and independently revertable. Task 4 is client-only and depends on
the wire types from 1–3 but on none of their behaviour — it can be written against them before they
are verified. Task 5 depends on 4 and is the first task where any of this is visible.

## Risks

- **Forgetting one delta path is the bug that will actually ship.** `stream_event` carries
  `parent_tool_use_id` just like `assistant` does, and sr03 sets `includePartialMessages: true`
  ([claude.ts:651](../../../server/src/agents/claude.ts:651)). Handle `assistant` and miss
  `stream_event` and the child's text still streams into the parent's composer while its completed
  form correctly lands in the tab — which reads as duplicated text, not as a routing bug. Task 2
  step 3 covers both cases in one edit for exactly this reason.
- **`tool_use_id` is optional.** If Claude ever omits it, the map is empty and every subagent
  message falls back to the transcript. That is the designed degradation, but it means "the tab is
  empty" has two causes. The task 2 verification asserts on the database, so an empty map is
  distinguishable from an empty tab.
- **`forwardSubagentText` raises stream volume on every delegating turn.** A parallel fan-out of
  twenty subagents will push twenty children's reasoning through one socket. There is no throttle
  in this plan and none in sr03 today. If it hurts, the lever is the option itself, and it is one
  line.
- **A parked thread with a live subagent.** Parking closes the CLI process
  ([runtime.ts:105](../../../server/src/agents/runtime.ts:105)); the messages already persisted
  stay, but no further ones arrive and the row keeps saying running forever. Task 4 marks rows
  stale when the thread has no session rather than leaving a permanent spinner.
- **`EditorGroups.onClose` is path-keyed.** Its signature is `(path: string) => void`
  ([EditorGroups.tsx:24](../../../web/src/components/EditorGroups.tsx:24)) and so are
  `closeFileTab` and the middle-click handler. A subagent tab has no path. Widening this to take an
  `EditorTab` touches the unsaved-changes confirm path in `ChatView`, so it is done deliberately in
  task 4 rather than worked around with a synthetic path string.
- **Two subagents streaming at once.** `streamByTask` is keyed by task id, so interleaving is
  handled by construction — but only if the delta events carry the task id rather than relying on
  ordering. They do; do not optimize that away.
- **Cursor sends `cursor/task` more than once per subagent.** The notification fires on tool-call
  updates, and the completion carries `durationMs` while the start does not. The handler must
  upsert by `toolCallId`, not append, or a single subagent produces several rows.
