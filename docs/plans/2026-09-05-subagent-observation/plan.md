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
work, because nothing was ever held in the tab.

**The correlation key is `tool_use_id`.** `task_started` carries an optional `tool_use_id`
identifying the Agent tool call that spawned the subagent, and every message produced inside that
subagent carries the same value as `parent_tool_use_id`. Note that `parent_tool_use_id` is **not on
the `SDKMessage` union** — it sits on five of its ~38 members — so it is read inside each `case`
that has it, never once at the top of `handleMessage`. The adapter keeps a `toolUseId → taskId` map
built as tasks start. `tool_use_id` is optional in the SDK's own type, so an unmapped
`parent_tool_use_id` **falls back to today's behaviour** and lands in the main transcript. A
subagent message must never be dropped for want of a mapping — a thinner transcript is a regression
a reviewer will catch, a silently missing message is not.

**`taskId` rides on the existing `AgentEvent` variants.** Five of them grow an optional field
rather than the boundary growing a second vocabulary for delegated work — including `phase`, which
is easy to miss and which otherwise paints the child's tool names onto the parent's activity label.
The one place that needs genuinely new wire events is streaming text: `thread.delta` feeds a single
per-thread buffer (`streamByThread`) that the composer renders, so subagent deltas pushed through
it would type the child's words into the parent's transcript. Those get `thread.task.delta` /
`thread.task.delta.end` and a `streamByTask` buffer keyed by task.

**`ThreadTask["status"]` gains `"stopped"`.** The SDK already distinguishes `stopped` from `failed`
and `killed`; `TASK_STATUS` (`claude.ts:104-112`) currently flattens all three onto `"failed"`.
Spec criterion 5 asks for a stopped row and criterion 7 for a failed one, so the union carries the
distinction rather than the view guessing it from an absent error string.

**Cursor needs no new task shape.** `cursor/task` maps onto the existing `ThreadTask`:
`subagentType → agentType`, and `durationMs` becomes `endedAt = startedAt + durationMs` rather than
a new field, so one renderer serves both providers. Only `model` is genuinely new on the row.

**Two capabilities, not one.** `subagentTranscripts` (Claude true, Cursor false) decides
transcript-or-card. `stopSubagents` (Claude true, Cursor false) decides whether a stop control is
offered. They happen to agree today, but they are different properties — Cursor could publish a
transcript without gaining a per-subagent cancel, and reusing one flag for both would hide that.
The client branches on capabilities, never on `providerId`.

Order matters: Cursor first because it is small and unit-testable and proves the row shape carries
both providers; then Claude's routing, which is the risky part; then stop; then the client. The app
works after every task — after task 2 subagent messages are correctly quarantined out of the
transcript with no tab yet to read them in, which is a deliberate half-step, not a broken state.

## Provenance for the Cursor protocol

Nothing in sr03 handles `cursor/task` today, and it is undocumented. The payload and the delivery
mechanism were read out of the shipped CLI bundle, version **2026.08.11-e8db854**, at
`~/.local/share/cursor-agent/versions/2026.08.11-e8db854/2996.index.js`. In
`sendToolExtensionNotification`, the `taskToolCall` branch builds:

```js
{ toolCallId, description, prompt, subagentType, model, agentId, durationMs }
```

and hands it to `sendNonBlockingExtensionNotification`, which calls
`this.connection.extMethod(method, payload).catch(swallow)` — the response is discarded either way.
`cursor/task` is one of exactly six `cursor/*` extension methods in that build (`ask_question`,
`create_plan`, `update_todos`, `task`, `generate_image`, `list_available_models`).

Because `extMethod` may frame this as a request or as a notification and the CLI ignores the
answer, **task 1 registers it in both dispatch tables**. `acp.ts` keeps request handlers and
notification handlers in disjoint maps (`acp.ts:339` and `acp.ts:364`), so registering only one
leaves a live feature silently inert against the other framing. Re-verify the payload against the
installed CLI version before trusting these field names if that version has moved.

## Global constraints

- **No new dependencies.** The view is composed from `components/ui` and `components/ui.tsx`.
- **Wire types move together.** `server/src/types.ts` and `web/src/lib/types.ts` are mirrors; a
  change to one without the other in the same commit is a defect. The one deliberate exception is
  `EditorTab`, which gains a client-only variant — see task 4.
- Server TS is type-stripped: no enums, no parameter properties, explicit `.ts` imports.
- UI comes from shadcn/ui, icons from `lucide-react` aliased in `components/ui.tsx`. Reuse the
  existing aliases — `AgentIcon` (`ui.tsx:219`) is already lucide `Bot` and is the subagent glyph.
- Colors are the shadcn token set only. Radii: `rounded-md` interactive, `rounded-lg` panels,
  `rounded-full` only for dots.
- **`ChatView` is the single writer for the layout.** It seeds `useState(() => normalize(thread.layout))`
  once per session (`ChatView.tsx:243`) and the `thread.updated` events its writes provoke are
  echoes it ignores. Any layout mutation added by this plan happens there, never in the store.
- **Zustand selectors must not build a fresh array.** Every new per-thread or per-task list uses a
  module-level empty constant, as `AgentsPanel.tsx:9` already does. Filtering belongs in a
  `useMemo` over the whole array, never inside the selector.
- **`streamByThread` must never receive subagent text.**
- Neither provider is done until a real turn has run through it against `/tmp/sr03-repo`.
- This plan adds no keyboard shortcut. If execution introduces one, its row goes in `SHORTCUTS.md`
  in the same commit.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/types.ts` | Modify | `ThreadTask.model`, `"stopped"` status; `subagentTranscripts` + `stopSubagents`; `thread.task.delta` / `.end` |
| `server/src/models.ts` | Modify | Cursor `tasks: true`; the two new capabilities on both providers |
| `server/src/agents/cursor.ts` | Modify | Session task map; `cursor/task` as both request and notification |
| `server/src/agents/cursor.test.ts` | Modify | Coverage for both framings and for the upsert |
| `server/src/agents/types.ts` | Modify | Optional `taskId` on five `AgentEvent` variants; `stopTask` on `AgentSession` |
| `server/src/agents/claude.ts` | Modify | `forwardSubagentText`; two correlation maps; per-case stamping; `stopTask`; `"stopped"` |
| `server/src/agents/runtime.ts` | Modify | Route stamped events; end task deltas on turn end; publish `thread.tasks` on rewind; export `stopTask` |
| `server/src/api.ts` | Modify | `POST /api/threads/:id/tasks/:taskId/stop` |
| `web/src/lib/types.ts` | Modify | Mirror of all of the above; `EditorTab` gains `subagent` |
| `web/src/lib/layout.ts` | Modify | `tabKey`, `persistable`, `subagentTabs` |
| `web/src/lib/layout.test.ts` | Modify | Key uniqueness, close/move, and the strip |
| `web/src/lib/api.ts` | Modify | `stopTask(threadId, taskId)` |
| `web/src/store.ts` | Modify | `streamByTask`; the two task delta events; strip on write |
| `web/src/components/EditorGroups.tsx` | Modify | `onClose` takes a tab; subagent chip fed by a `labels` prop |
| `web/src/components/FileView.tsx` | Modify | `onClose` / `onMissing` take a tab, not a path |
| `web/src/components/ChatView.tsx` | Modify | Retargeted close path; prune tabs for vanished tasks; open a subagent |
| `web/src/components/SubagentView.tsx` | Create | The tab body: transcript for Claude, card for Cursor |
| `web/src/components/Timeline.tsx` | Modify | Optional `taskId` scope; filter the main transcript; clickable delegation row |
| `web/src/components/AgentsPanel.tsx` | Modify | Rows open a tab; stop control; `model`; parked rows |
| `CLAUDE.md` | Modify | One Layout line; one Cursor gotcha |

## Tasks

1. [tasks/01-cursor-task-notification.md](tasks/01-cursor-task-notification.md) — `cursor/task` → task rows, with tests
2. [tasks/02-claude-subagent-routing.md](tasks/02-claude-subagent-routing.md) — forwarding, correlation, task-scoped messages and deltas
3. [tasks/03-stop-a-subagent.md](tasks/03-stop-a-subagent.md) — `stopTask` through the boundary and out as a route
4. [tasks/04-client-tab-model.md](tasks/04-client-tab-model.md) — types, `tabKey`, store, tab plumbing, with tests
5. [tasks/05-subagent-view.md](tasks/05-subagent-view.md) — the view, the transcript filter and row, the panel wiring

Tasks 1, 2 and 3 are server-only and independently revertable. Task 4 is client-only and depends on
the wire types from 1–3 but on none of their behaviour. Task 5 depends on 4 and is the first task
where any of this is visible.

## Risks

- **Forgetting one emit path is the bug that will actually ship.** There are four in `claude.ts`
  that need stamping and they are in three different `case` blocks: `stream_event` (line ~533,
  deltas *and* `phase`), `assistant` (~546, text and `tool.started`), and `user` (~559,
  `tool.completed`). Miss the `stream_event` deltas and the child's text streams into the parent's
  composer while its settled form lands correctly in the tab, which reads as duplicated text.
  Miss `phase` and the parent's waiting label narrates the child's tools.
- **`tool_use_id` is optional.** If Claude omits it, the map is empty and every subagent message
  falls back to the transcript. That is the designed degradation, but it means "the tab is empty"
  has two causes. Task 2's verification asserts on the database, so an empty map is distinguishable
  from an empty tab.
- **`forwardSubagentText` raises stream volume on every delegating turn.** A fan-out of twenty
  subagents pushes twenty children's reasoning through one socket. There is no throttle in this
  plan and none in sr03 today. If it hurts, the lever is the option itself, and it is one line.
- **The layout has one writer and it is not the store.** Anything that mutates `state.threads[].layout`
  is writing to a copy `ChatView` never reads. This has already caught one draft of this plan.
- **A parked thread with a live subagent.** Parking closes the CLI process ten minutes after the
  thread goes idle (`runtime.ts:107`), so "idle" is not "parked" and must not be used as the
  liveness proxy. `agents.hasSession(threadId)` is the real signal.
- **Two subagents streaming at once.** `streamByTask` is keyed by task, so interleaving is handled
  by construction — but only if the delta events carry the task id rather than relying on ordering.
  They do; do not optimize that away.
- **Cursor sends `cursor/task` more than once per subagent**, and the completion carries
  `durationMs` while the start does not. Upsert by `toolCallId` and derive the row `id` from
  `toolCallId` alone — deriving it from `agentId` when present makes the row's identity change
  between the two notifications and closes any tab already open on it.
- **`EditorGroups.onClose` is path-keyed, and so is a chain behind it.** `FileView.onClose`,
  `FileView.onMissing`, `ChatView`'s `pendingClose`, `saveAndClose`, `closeFile`, `promptNextDirty`
  and the `⌘W` handler at `ChatView.tsx:509` all pass a `string`. Widening to `EditorTab` is one
  connected change; doing half of it typechecks in neither direction.
