# Task 5: The subagent view

**Depends on:** Task 4

**Files:**
- Create: `web/src/components/SubagentView.tsx` — the tab body
- Modify: `web/src/components/Timeline.tsx` — `taskId` scope; transcript filter; delegation row
- Modify: `web/src/components/AgentsPanel.tsx` — rows open a tab; stop; `model`; stale rows
- Modify: `web/src/components/ChatView.tsx` — replace the task 4 placeholder; wire the panel
- Modify: `CLAUDE.md` — one Layout line; one Cursor gotcha

**Interfaces:**
- Produces: `<SubagentView thread={thread} taskId={string} files={FileLinks} onRun={(cmd: string) => void} />`
- Consumes: `openSubagent(taskId)` from task 4, `api.stopTask`,
  `provider.capabilities.subagentTranscripts` and `.stopSubagents`.

## Notes before starting

**Reuse `Timeline`, do not write a second transcript renderer.** It already owns tool grouping,
markdown, file links, streaming tails and the copy affordances.

`Timeline`'s props today are `{ threadId, running, files, onRun, onRewind }`, **all required**
(`Timeline.tsx:589-601`). This task adds an optional `taskId` and makes `onRewind` optional, with
the rail and the rewind affordance hidden when it is absent — a subagent has no turns of its own to
rewind to. `SubagentView` therefore takes `onRun` from `ChatView` and passes it straight through;
it does not invent one.

**Branch on the right capability.** `subagentTranscripts` decides transcript-or-card.
`stopSubagents` decides whether a stop control appears. They agree today and are still two
different questions.

**Staleness needs no new wire field.** A row is stale when `task.status === "running"` while
`thread.status !== "running"` — the turn ended, or the thread was parked, and nothing more will
arrive. That covers parking without needing to know about `IDLE_PARK_MS`.

Task 1 made `"stopped"` a real `ThreadTask` status, so nothing here infers it from a missing error
string.

## Steps

- [ ] 1. In `Timeline.tsx`, add an optional `taskId?: string` prop and make `onRewind` optional.
      When `taskId` is set: filter `messages` in a `useMemo` to those whose
      `meta?.taskId === taskId`, read the streaming tail from `streamByTask[threadId]?.[taskId]`
      instead of `streamByThread[threadId]`, and render neither `TurnRail` nor the rewind
      affordance. Never filter inside the selector.

- [ ] 2. In the same file, when `taskId` is **not** set, filter out every message whose
      `meta?.taskId` is a string. This is the line that stops delegated work appearing twice.

- [ ] 3. In the same file, make the parent's Agent tool call clickable. The parent's own
      `Task` / `Agent` tool row survives the step-2 filter because it carries no `meta.taskId`;
      `Timeline.tsx:28` already labels it `{ verb: "Launched", noun: "agents" }`. Add an
      `onOpenSubagent?: (taskId: string) => void` prop, and in `ToolRow`, when the message's
      `meta.toolName` is `Task` or `Agent` and its `meta.toolUseId` matches a task in
      `tasksByThread`, render the row as a button that calls it with that task's id. Match on the
      task's `id`, which for Claude is the `task_id` — so look the task up by scanning
      `tasksByThread` for the one whose row was opened by this tool call. If no task matches,
      render exactly as today; a non-clickable row is the correct fallback, not an error.

- [ ] 4. Run `pnpm dev` and re-run the task 2 harness turn
      (`Use the Explore subagent to list every file in this repo and report what it found.`).
      Confirm the main transcript shows the parent's summary and none of the subagent's own tool
      calls, and that the delegation row is present.

- [ ] 5. Create `web/src/components/SubagentView.tsx`. It looks the task up in `tasksByThread` and
      renders:
      - a header: the description, then `agentType`, `model`, elapsed time and token/tool counts
        in the same `font-mono text-[10.5px] text-faint` treatment `AgentsPanel` uses;
      - the word `stopped` or `failed` in the header when the status is one of those, and
        `task.error` beneath it in `text-destructive` when present — this is spec criterion 7;
      - `no longer live` in the header when the task is stale by the rule above;
      - a stop button, shown only while `status === "running"` and
        `capabilities.stopSubagents` is true, calling `api.stopTask` and surfacing a failed call
        through the store's existing `error` banner;
      - the body: `<Timeline threadId={thread.id} taskId={taskId} running={task?.status === "running"} files={files} onRun={onRun} />`
        when `capabilities.subagentTranscripts`, otherwise the Cursor card;
      - when the task id is absent from `tasksByThread`, a single line reading
        `This subagent is no longer tracked.` rather than an empty panel.

- [ ] 6. Write the Cursor card in the same file: description, subagent type, model, status and
      duration, plus one sentence — *"Cursor reports that a subagent ran, but does not publish what
      it did. Its result is folded into the reply above."* Use `text-muted-foreground`, no icon, no
      error styling. This is information, not a failure.

- [ ] 7. In `ChatView.tsx`, replace the task 4 placeholder in the tab-body list with
      `<SubagentView thread={thread} taskId={tab.taskId} files={links} onRun={runCommand} />`,
      keeping it inside the same flat `layout.groups.flatMap` list so it is never re-parented.
      Pass `onOpenSubagent={openSubagent}` to the chat tab's `Timeline`.

- [ ] 8. In `AgentsPanel.tsx`, add an `onOpen: (taskId: string) => void` prop and make each
      `TaskRow`'s body a button that calls it; wire it in `ChatView` to `openSubagent`. Add
      `model` beside `agentType` in the row's metadata line. Keep the existing
      `paddingLeft: 12 + (task.depth - 1) * 12` depth indent — the spec's non-goal rules out an
      expand-collapse hierarchy, not this indent.

- [ ] 9. In `AgentsPanel.tsx`, add a `stale` computation per row (`task.status === "running" &&
      thread.status !== "running"`) that renders the idle dot and the word `parked` in place of the
      elapsed clock. Pass `thread` into `TaskRow`, or compute the flag in `AgentsPanel` and pass it
      as a boolean prop — `useClock` stays where it is at panel level. Add a stop control on hover
      for running, non-stale rows, gated on `capabilities.stopSubagents`.

- [ ] 10. Run `pnpm typecheck && pnpm test`. Expect: both pass.

- [ ] 11. Full manual pass on `/tmp/sr03-repo`, Claude thread. Run the harness turn, then check
       each of these against its spec criterion:
       - (1, 2) the panel row shows type and description; opening it shows the subagent's work,
         and none of that work is in the main transcript;
       - (3) text streams into the open tab live;
       - (4) on finish the tab shows the final report and the row shows a duration;
       - (5) stop settles the row to `stopped` and the tab keeps its content;
       - (6) close the tab, reopen from the panel, content is identical;
       - (8) a prompt that delegates three ways gives three rows and three tabs;
       - (9) ask for a nested delegation and confirm the deeper row records a greater depth;
       - (13) run a turn that spawns nothing and confirm the transcript and tab strip look exactly
         as they do on `main`.

- [ ] 12. Verify criterion 12 by parking. Restart the dev server with `SR03_IDLE_PARK_MS=15000`,
       run the harness turn, and once the turn ends wait past the park. The row reads `parked`, the
       tab stays open showing what was captured, the header says `no longer live`, and nothing
       errors in the console.

- [ ] 13. Verify criterion 7 by failing a subagent: prompt
       `Use a subagent to run the command "exit 9" and report the result`, or stop the thread
       mid-subagent. Confirm the row reads `failed` and the tab shows the error text.

- [ ] 14. Repeat the pass on a Cursor thread (`Use a subagent to summarise every file in this
       repo.`). Confirm criteria 10 and 11: the row carries description, type, model and duration;
       the tab shows the card and not an empty transcript; no stop button is offered.

- [ ] 15. Update `CLAUDE.md`: one line under Layout for `components/SubagentView.tsx`, and one
       bullet under "Cursor session gotchas" recording that `cursor/task` arrives on both the
       request and notification paths, carries only description, prompt, subagent type, model,
       agent id and duration, and that no child transcript exists to render.

- [ ] 16. `git add web/src/components/SubagentView.tsx web/src/components/Timeline.tsx web/src/components/AgentsPanel.tsx web/src/components/ChatView.tsx CLAUDE.md`
       `git commit -m "feat(threads): open a subagent in its own tab"`

## Done when

Every acceptance criterion in the spec has been checked by hand on both providers, including the
failure, parked and no-subagent cases in steps 12–14.
