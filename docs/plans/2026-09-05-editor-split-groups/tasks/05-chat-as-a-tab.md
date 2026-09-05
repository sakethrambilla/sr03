# Task 5: Chat becomes a movable tab

**Depends on:** Task 4
**Files:**
- Modify: `web/src/components/EditorGroups.tsx`
- Modify: `web/src/components/ChatView.tsx`
- Modify: `web/src/components/Composer.tsx` — only if step 7 finds a control unreachable

**Interfaces:**
- Consumes: `CHAT`, `moveTab` and the exactly-one-chat guarantee from task 2.
- No new exports. This changes where the chat pane may render, not what it is.

**A visible change this task makes deliberately:** today the tab strip appears only once a file is
open ([ChatView.tsx:583](../../../../web/src/components/ChatView.tsx:583)). Once chat is a tab, the
strip is always present, showing at least the chat tab. That is intended — a strip that appears and
disappears cannot be a drop target — but it means task 4's "indistinguishable from before the
feature" no longer holds, and step 9 is what replaces that check.

## Steps

- [ ] 1. In `EditorTabs`, render `kind: "chat"` tabs instead of skipping them: the existing
      `MessageIcon` and the thread title, styled exactly as the current pinned chat button. The chat
      tab renders **no close control at any position** — it is movable but never closable.

- [ ] 2. Delete the separately rendered pinned chat button from `ChatView` and the conditional that
      hides the strip when no files are open. The strip now always renders.

- [ ] 3. In `ChatView`, move the `Timeline` + `ThreadComposer` pair out of its current position and
      into the same flat child list as the file views, wrapped in a `<div>` carrying the
      `gridColumn` / `gridRow` of whichever group holds the chat tab, hidden unless it is that
      group's active tab. Give it a stable `key="chat"`. **It stays at that one position in the
      React tree for the life of the session**, exactly like the file views and for the same reason:
      the composer holds an unsent draft, and a remount would discard it.

- [ ] 4. Confirm `closeAll`, `renamed` and `deleted` never remove the chat tab. `normalize` would
      re-insert it, but that would show up as chat jumping to another group — fix the caller rather
      than relying on the repair.

- [ ] 5. Confirm `⌘W` on a group whose active tab is chat still does nothing, and that `⌘K W` leaves
      chat alone.

- [ ] 6. Run `pnpm typecheck` and `pnpm test`. Expect: both clean.

- [ ] 7. **The narrow-chat check.** With `pnpm dev`: open a file, `⌘\` to split, then move focus and
      use `⌘\` until chat and a file sit side by side. Drag the sash until the chat group is at its
      `MIN_FRACTION` minimum. Expect: the transcript wraps and stays readable, and the composer's
      textarea, send button, model picker and permission picker are all reachable, with their
      popovers opening inside the window rather than clipped.
      If a control is unreachable, add the smallest responsive change to `Composer.tsx` that fixes
      it — do not raise `MIN_FRACTION` to dodge the problem, and do not restyle the composer beyond
      the narrow case. If nothing is unreachable, make no change and record that in progress.md;
      `Composer.tsx` is in this task's file list conditionally, not by default.

- [ ] 8. **The streaming check.** With chat in a narrow group beside an open file, send a prompt
      that produces a long reply. Expect: the transcript autoscrolls as it streams, and typing into
      the file beside it during the stream drops no keystrokes.

- [ ] 9. **The invariant check.** Move chat into the second group, reload. Expect: chat reopens in
      the second group, and there is exactly one chat tab. Then close every file tab. Expect: one
      group holding only the chat tab, the transcript full width, and the strip showing that single
      tab — the intended difference from `main` described above.

- [ ] 10. **The unsent-draft check.** Type a message into the composer without sending it, then
      `⌘\` a file out into another group. Expect: the draft text is still in the composer.

- [ ] 11. Commit:
      `git add web/src/components/ChatView.tsx web/src/components/EditorGroups.tsx`
      (add `web/src/components/Composer.tsx` only if step 7 changed it)
      `git commit -m "feat(editor): let the chat tab live in any group"`

## Done when
Chat renders as an ordinary tab in whichever group holds it, cannot be closed from any position,
stays exactly one per session across a reload, keeps an unsent draft through a split, and streams
and autoscrolls correctly at the minimum group width.
