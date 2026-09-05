# Spec — Cursor slash commands

## Problem

Typing `/` in the composer offers command suggestions on a Claude thread and nothing at all on a
Cursor thread. This is not a regression: the Cursor adapter has never returned a command list, and
the provider capability that gates the composer's `/` menu is switched off for Cursor. From the
user's seat it reads as a broken provider — the same keystroke does something on one provider and
silently nothing on the other.

## Goal

A Cursor thread offers the same `/` command experience a Claude thread does: typing `/` lists the
commands cursor-agent itself advertises, filtered as you type, and picking one sends that command
to the agent.

## Users and value

The single user of this app, switching providers per thread. The value is that provider choice
stops silently removing a core composer affordance.

## Decisions taken at scoping

- **List source: the ACP session.** The command list comes from what cursor-agent advertises over
  ACP — the command set returned when a session is created or loaded, plus any later update
  notification the agent sends. sr03 does not read Cursor's command files off disk and does not
  reimplement Cursor's own resolution rules. Whatever the agent offers is the list.
- **Cold start spawns a throwaway session.** When the command list is requested for a folder that
  has no live Cursor session, sr03 starts a short-lived agent connection, reads the advertised
  commands, closes it, and caches the result for that folder — the same shape Claude already uses,
  and the same shape Cursor's model list already uses at startup.
- **Invocation is plain prompt text.** Choosing a command inserts `/name` (plus arguments) into
  the composer and sends it as an ordinary prompt. cursor-agent interprets the leading slash
  itself. No separate command-invocation protocol call.
- **Cursor only; no shared refactor.** The per-folder cache and live-session-first lookup that the
  Claude adapter already has are reimplemented inside the Cursor adapter rather than lifted into a
  provider-neutral helper. The Claude adapter is not edited. Some duplication between the two
  adapters is accepted as the price of keeping a working provider out of the diff.

## Acceptance criteria

1. With a Cursor thread open on a folder whose Cursor installation advertises at least one
   command, typing `/` in the composer shows a suggestion list containing that command's name.
   Typing further characters narrows the list to names *containing* the typed text — the composer's
   existing filter is a substring match, and this change does not alter it.
2. Typing `/` in a Cursor thread on a folder that advertises no commands shows the composer's
   existing empty/no-match state, not a stuck loading state and not an error toast. Known
   limitation, inherited and not introduced here: the client caches an empty list for a
   provider+folder for the life of the page (`store.ts:702` treats `[]` as present), so recovery
   after a failed read needs a reload. Fixing that would mean editing `web/`, which is out of
   scope.
3. Selecting a command from the list and submitting sends a prompt whose text begins with
   `/<command-name>`, and the agent's reply appears in the transcript as an ordinary assistant
   turn.
4. Requesting the command list for a folder with no live Cursor session returns the same list as
   requesting it with a live session on that folder, within one request, without leaving a
   cursor-agent process running afterwards.
5. If the agent sends a command-list update mid-session, the composer's `/` list reflects the new
   set on the next `/` without reloading the page.
6. If cursor-agent is not installed or fails to start, the command request resolves to an empty
   list and logs one server-side error line; the composer shows the empty state and the thread
   remains usable.
7. Claude threads are unaffected, and no file the Claude adapter owns appears in the diff.
8. `pnpm typecheck` and `pnpm test` pass.

## Out of scope

- Reading or parsing Cursor command definition files on disk.
- Any command UI beyond the existing composer `/` menu — no palette entry, no help panel, no
  per-command argument form beyond the existing argument hint.
- Any edit to the Claude adapter, and any lifting of its command cache into shared code.
- The `@` mention menu, which is a separate input path.
- Cursor's other unimplemented capabilities (usage, tasks, fork, live model switching). This
  change flips exactly one capability flag.
- Persisting the command list across server restarts.

## Open questions

Both scoping-time unknowns were resolved by probing a real `cursor-agent acp` process during
exploration; the findings are recorded at the top of the plan.

- **Resolved.** Cursor does not return commands from session creation at all — it pushes them as an
  `available_commands_update` notification shortly afterwards, and offers no request method to ask
  for them. Criterion 5 is therefore the primary path, not a vacuous one, and the cold-start read
  has to wait for a push rather than read a response.
- **Resolved, with a caveat.** The advertised entries carry only `name` and `description` — there is
  no argument hint. The hint field is filled with an empty string, so the composer renders the same
  row Claude's hintless commands already render.
