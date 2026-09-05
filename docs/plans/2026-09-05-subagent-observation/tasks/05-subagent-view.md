# Task 5: The subagent view

**Depends on:** Task 4

**Files:**
- Create: `web/src/components/SubagentView.tsx` — the tab body
- Modify: `web/src/components/Timeline.tsx` — optional `taskId` scope; filter the main transcript
- Modify: `web/src/components/AgentsPanel.tsx` — rows open a tab; stop control; `model` on the row
- Modify: `web/src/components/ChatView.tsx` — replace the task 4 placeholder
- Modify: `web/src/components/ui.tsx` — `UserRound` / `StopIcon` lucide aliases if not already added
- Modify: `CLAUDE.md` — one Layout line; one Cursor gotcha

**Interfaces:**
- Consumes: `messagesByThread[threadId]` filtered on `meta.taskId`, `tasksByThread[threadId]`,
  `streamByTask[threadId][taskId]`, and `provider.capabilities.subagentTranscripts`.
- Produces: `<SubagentView thread={thread} taskId={string} files={FileLinks} />`.

## Notes before starting

**Reuse `Timeline`, do not write a second transcript renderer.** It already owns tool grouping,
markdown, file links, streaming tails and the copy affordances. Give it an optional `taskId` and
let one component serve both scopes — that is the repo's stated preference over a parallel
implementation.

**Branch on the capability, never on `providerId`.** `subagentTranscripts` exists so the Cursor
card is a capability outcome rather than a provider special case.

`trackTask` maps the SDK's `stopped` status onto `"failed"` (`claude.ts:108`). A subagent the user
stopped therefore arrives as `failed` with no error text. Render `status === "failed" && !error` as
**Stopped**, not Failed. Do not change the server mapping — `ThreadTask["status"]` is a three-value
union used in several places, and widening it is not worth it for a label.

## Steps

- [ ] 1. In `Timeline.tsx`, add an optional `taskId?: string` prop. When set: filter `messages` to
      those whose `meta?.taskId === taskId`, read the streaming tail from
      `streamByTask[threadId]?.[taskId]` instead of `streamByThread[threadId]`, and render neither
      the turn rail nor the rewind affordance — a subagent has no turns of its own to rewind to.
      Do the filtering in a `useMemo` over the whole array; **never** filter inside the selector.

- [ ] 2. In the same file, when `taskId` is **not** set, filter out every message that has a
      `meta.taskId`. This is the line that stops delegated work appearing twice.

- [ ] 3. Run `pnpm dev` and re-run the task 2 harness turn
      (`Use the Explore subagent to list every file in this repo and report what it found.`).
      Confirm the main transcript shows the parent's summary and none of the subagent's own tool
      calls. This is the same state task 2 step 8 checked, now enforced client-side rather than by
      the messages being absent.

- [ ] 4. Create `web/src/components/SubagentView.tsx`. It takes `thread` and `taskId`, looks the
      task up in `tasksByThread`, and renders:
      - a header row: the description, then `agentType`, `model`, elapsed time and token/tool
        counts in the same `font-mono text-[10.5px] text-faint` treatment `AgentsPanel` uses;
      - a stop button, shown only while `status === "running"` and only when
        `capabilities.subagentTranscripts` is true, calling `api.stopTask`;
      - the body: `<Timeline threadId={thread.id} taskId={taskId} ... />` when
        `capabilities.subagentTranscripts`, otherwise the Cursor card;
      - when the task id is not in `tasksByThread` at all, a short "this subagent is no longer
        tracked" line rather than an empty panel.

- [ ] 5. Write the Cursor card in the same file: the description, the subagent type, the model, the
      status and the duration, plus one sentence of explanation —
      *"Cursor reports that a subagent ran, but does not publish what it did. Its result is folded
      into the reply above."* Use `text-muted-foreground`, no icon, no error styling. This is
      information, not a failure.

- [ ] 6. In `ChatView.tsx`, replace the task 4 placeholder in the tab-body list with
      `<SubagentView thread={thread} taskId={tab.taskId} files={links} />`, keeping it inside the
      same flat `layout.groups.flatMap` list so it is never re-parented.

- [ ] 7. In `AgentsPanel.tsx`, make each `TaskRow` a button that calls a new `onOpen(taskId)` prop,
      wired in `ChatView` to `openTab(layout, { kind: "subagent", taskId }, focusedGroup)`. Add
      `model` beside `agentType` in the row's metadata line. Add a stop control on hover for
      running rows, using the same `api.stopTask` call, and hide it when
      `capabilities.subagentTranscripts` is false.

- [ ] 8. Mark rows stale: when the thread has no live session, a `running` row renders with the
      idle dot and the word `parked` in place of its elapsed clock, so a parked thread does not
      spin forever. `useClock` already gates on `live`; pass it `running > 0 && thread.status !== "idle"`.

- [ ] 9. Run `pnpm typecheck && pnpm test`. Expect: both pass.

- [ ] 10. Full manual pass on `/tmp/sr03-repo`, Claude thread. Run the harness turn, then check
       every one of these:
       - the agents panel row opens a tab; the tab streams the subagent's text live;
       - the tab's content is absent from the main transcript;
       - closing the tab and reopening from the panel restores identical content;
       - the stop button on a running subagent settles the row and the tab keeps its content;
       - a turn that spawns three subagents gives three rows and three independently openable tabs;
       - reload the page: the split layout returns, subagent tabs do not, and no layout is lost.

- [ ] 11. Repeat on a Cursor thread with a prompt that delegates
       (`Use a subagent to summarise every file in this repo.`). Confirm the row carries the
       description, type, model and duration, the tab shows the card and not an empty transcript,
       and no stop button is offered.

- [ ] 12. Update `CLAUDE.md`: one line under Layout for `components/SubagentView.tsx`, and one
       bullet under "Cursor session gotchas" recording that `cursor/task` is a fire-and-forget
       notification carrying only description, prompt, subagent type, model, agent id and duration
       — no child transcript exists to render.

- [ ] 13. `git add web/src/components/SubagentView.tsx web/src/components/Timeline.tsx web/src/components/AgentsPanel.tsx web/src/components/ChatView.tsx web/src/components/ui.tsx CLAUDE.md`
       `git commit -m "feat(threads): open a subagent in its own tab"`

## Done when

Every acceptance criterion in the spec passes by hand on both providers: a Claude subagent opens as
a live tab that can be stopped and reopened, a Cursor subagent opens as a card that explains
itself, and a thread that spawns no subagents is indistinguishable from today.
