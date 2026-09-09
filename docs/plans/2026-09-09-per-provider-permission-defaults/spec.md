# Per-provider default permission mode

## Problem

The default permission mode for new sessions is a single machine-wide value. It lives on the
Settings → General tab, under "Session defaults", and its list of choices is drawn from whichever
provider happens to be the default one. Claude and Cursor do not share a permission vocabulary —
Claude has `default` / `plan` / `acceptEdits` / `bypassPermissions`, Cursor has `default` / `plan` /
`ask` / auto-review and force flags — so one shared value is wrong in two ways:

- Picking Bypass for Claude silently falls back to Cursor's built-in default when a Cursor thread is
  started, with nothing in the UI saying so.
- The General tab shows only the default provider's choices, so the other provider's default cannot
  be expressed at all.

The natural home for a provider-scoped preference is the provider's own card on Settings →
Providers, next to that provider's models, account and binary path.

## Goal

Each provider carries its own saved default permission mode, chosen on that provider's card in
Settings → Providers, persisted on the machine, and applied to every new session started with that
provider.

## Users and use

One user, one machine. They open Settings → Providers, see a permission-mode picker on the Claude
card and another on the Cursor card, set each independently, and every new thread they start picks
up the value belonging to its own provider.

## Requirements

1. Both provider cards on Settings → Providers show a permission-mode picker, listing exactly that
   provider's own modes and showing that provider's currently saved default.
2. Changing a provider's picker persists immediately, with no explicit save step, and survives a
   server restart.
3. A new session started with a provider uses that provider's saved default permission mode.
   Switching the provider inside the new-session draft switches the pre-selected permission mode to
   the newly chosen provider's saved default.
4. A change made in one open client is reflected in every other open client without a reload.
5. Sessions already running are unaffected by a change to a default.
6. The existing single machine-wide value is migrated onto the provider that is currently the
   default provider; the other provider starts from its built-in default.
7. The Settings → General tab is removed. Its remaining content, the "Open diagrams in preview"
   switch, moves to the Appearance tab. Providers becomes the section shown when Settings opens
   with no remembered choice.

## Acceptance criteria

- Opening Settings → Providers shows a "Permission mode" row on each provider card whose options
  are that provider's own modes: the Claude card offers Bypass and Accept edits, the Cursor card
  does not, and the Cursor card offers Ask, which the Claude card does not.
- Setting the Claude card to Bypass, restarting the server, and reopening Settings → Providers shows
  Claude still on Bypass and Cursor unchanged.
- With Claude set to Bypass and Cursor set to Plan: starting a new session with Claude selected
  shows Bypass in the composer's permission chip; switching that same draft's provider to Cursor
  changes the chip to Plan.
- With two browser tabs open on Settings → Providers, changing the Cursor card in one updates the
  Cursor card in the other without a reload.
- Changing a provider default while a session is mid-turn leaves that session's permission chip
  unchanged.
- Starting from a machine whose stored default is `bypassPermissions` and whose default provider is
  Claude, after this change the Claude card reads Bypass and the Cursor card reads its built-in
  default.
- The Settings header lists two sections, Providers and Appearance; the "Open diagrams in preview"
  switch appears under Appearance and still governs how a `.mmd` file opens.

## Out of scope

- Per-provider default model, effort, or fast — the Models list on the card stays read-only.
- Per-project or per-thread defaults; this stays machine-wide-per-provider.
- Any change to how a running session's permission mode is switched from the composer.
- Adding, removing or renaming permission modes for either provider.
- Cursor's auto-review and force flags.
- Any new provider.

## Open questions

None.
