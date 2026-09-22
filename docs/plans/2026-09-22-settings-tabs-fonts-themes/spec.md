# Settings tabs, richer appearance, and Codex fixes

## Problem

Three things, found together while checking whether the Codex provider landed cleanly.

**Providers settings don't scale.** The Providers section stacks Claude Code, Cursor CLI and Codex
CLI as three full cards one below the other. Each card carries a state dot, sign-in hint, account
fields, binary path, permission-mode picker, a models list and a logout button, so comparing two
providers means scrolling past everything in between, and a fourth provider would make the page
unusable. Only one provider is ever the subject of attention at a time.

**Appearance has almost nothing to try.** The font pickers only offer faces already installed on
the machine — the panel measures each candidate against a generic and silently drops any it can't
find — so the list a given machine shows is short, arbitrary, and different from the next machine's.
The theme set is sr03's own palette plus the twelve stock shadcn palettes, which are deliberately
neutral: twelve variations on grey with one accent hue. There is nothing expressive to pick.

**Codex has a transcript bug.** An audit against the Claude and Cursor adapters found Codex is
otherwise substantially complete — it does turns, interrupts, approvals, questions, task cards,
skills, models, parking and crash handling, and typecheck and the 51 tests pass. But when Codex
emits more than one assistant message inside a single turn, everything after the first message is
shown live and then lost on reload, because the adapter latches "this turn's message is finished"
on the first message instead of at the end of the turn. Two smaller issues sit alongside it: a
failed turn carrying no error message ends as a silent clean completion, and the usage figures a
thread shows are a module-wide global that ignores which thread asked and survives its deletion.

## Goals

- Make the Providers section navigable by provider rather than by scroll position.
- Give the appearance panel enough fonts and enough visually distinct themes to actually choose
  from, on any machine, without depending on what happens to be installed.
- Fix the confirmed Codex defects so a Codex transcript survives a reload and stops attributing
  its own work to Cursor.

## Non-goals / out of scope

- **No new provider.** The tab strip must handle N providers, but nothing beyond the current three
  is being added.
- **No redesign of the settings shell.** The left-hand Providers/Appearance nav, the header, the
  Escape-to-close behaviour and the Editor panel stay exactly as they are.
- **No change to what a provider card contains.** The tabs change how you reach a provider's
  settings, not which settings it has.
- **No change to the editor-semantic colors.** Diff, syntax and file-icon hues are defined once and
  deliberately survive every theme; new themes restyle chrome only.
- **No theme removal.** The existing palette plus the twelve shadcn palettes all stay.
- **No font-size, line-height or density controls.** Family only.
- **No Codex work beyond the confirmed defects.** Subagent transcripts, task cancellation and
  per-thread cost are absent because the Codex protocol doesn't expose them, not because they were
  forgotten; they stay absent.
- **No server-side appearance model.** Appearance keeps its current storage shape.

## Decisions taken

**Fonts are bundled, not discovered.** The chosen approach is to ship a curated set of webfonts
with the app rather than only widening the list of names probed on the machine. Discovery alone
would have meant most expressive picks never appearing, and the same setting rendering differently
on two machines. Bundling costs payload size in the packaged app and makes the font files a
dependency, which is the accepted trade. Machine-installed faces that are currently offered stay
offered — bundled and installed fonts are both listed, distinguished so it's clear which is which.

The bundled set is twelve interface and twelve code families, chosen to span neutral working faces
through expressive display ones: Inter, Geist, IBM Plex Sans, Source Sans 3, Public Sans, Outfit,
Bricolage Grotesque, Instrument Sans, Space Grotesk, Sora, Fraunces and Lora for the interface;
JetBrains Mono, Fira Code, IBM Plex Mono, Source Code Pro, Geist Mono, Iosevka, Space Mono, Commit
Mono, Martian Mono, Red Hat Mono, Azeret Mono and Recursive for code.

**Six new themes, nothing removed.** Neon (cyberpunk magenta and cyan on near-black), Bloom (a soft
blush and cream aesthetic), Terminal (green phosphor), Dune (warm sand and terracotta), Nord (cool
arctic blue) and Mono (greyscale with a single accent) — appended to the existing set. The picker
grid absorbs the extra rows without restructuring.

**The default-provider control stays above the tabs.** It's a setting about the set of providers,
not about any one of them, so it stays pinned and visible whichever tab is active.

## Acceptance criteria

### Provider tabs

1. Opening Settings → Providers shows one horizontal strip with one entry per provider, and exactly
   one provider's card below it.
2. Each strip entry shows the provider's name and its brand mark, and carries the same
   ready/missing state indication the card headers use today, so a provider needing sign-in is
   visible without selecting it.
3. Selecting an entry replaces the card below with that provider's, and leaves the default-provider
   control above the strip untouched and still operable.
4. The selected provider survives closing and reopening Settings, and a page reload.
5. If the remembered provider is no longer in the list, the first provider is selected instead of
   rendering an empty panel.
6. Before provider statuses have loaded, the section shows its existing "Checking…" state and no
   empty tab strip.
7. Changing a provider's permission mode, or signing out of a provider, refreshes that provider's
   card without switching the selected tab.
8. The strip is reachable by keyboard: arrow keys move between providers and the selection follows.

### Fonts

9. The interface and code font pickers each list the bundled families on every machine, regardless
   of what is installed locally, plus any machine-installed families the existing probe finds.
10. Bundled and machine-installed entries are visually separated in the picker, so it's clear which
    will look the same on another machine.
11. Each entry in the picker renders in its own face, and picking one restyles the app immediately
    with no reload.
12. "System default" remains available and clears the override.
13. A bundled font chosen while the machine is offline still renders in that face.
14. A previously chosen machine-installed font that is no longer available falls back to the
    stack's next face rather than rendering blank or throwing.

### Themes

15. The theme grid offers the existing entries plus six new ones, each with a swatch drawn from
    that theme's own tokens.
16. Every new theme is legible in both light and dark mode: body text against its background, and
    muted text against its card surface, both clear enough to read comfortably.
17. Switching to any new theme leaves diff, syntax and file-icon colors unchanged.
18. The chosen theme survives a reload, and a chosen theme plus "System" mode still follows the OS
    light/dark flip.

### Codex fixes

19. When Codex emits two or more assistant messages within one turn, every message is still present
    in the transcript after a reload.
20. A Codex turn that fails without an error message ends with a visible error rather than as a
    silent clean completion.
21. Opening a Codex task card does not describe the work as Cursor's.
22. The usage figures shown for a thread are not another thread's, and are not served for a thread
    that has been deleted.

## Open questions

- **Which specific families to bundle.** The plan proposes a concrete list, but the point of the
  change is to have things to try — expect the list to be revised once they're on screen. The list
  is cheap to change afterwards.
- **Whether the six new themes are the right six.** Same: directional, and judged by eye.
- **Codex per-thread cost.** The protocol exposes account-wide rate limits only, so the thread's
  usage meter can be made honest (criterion 22) but cannot be made complete. Whether the UI should
  say so explicitly is left open.
- **Whether plan output belongs in the reply.** Codex concatenates plan deltas into the assistant
  message text. This was initially recorded as a defect, then withdrawn: Cursor does the same thing
  deliberately, with de-duplication and a guard that only folds a plan in while the reply is still
  empty. So Codex is consistent with its sibling, not broken, and changing it would mean changing a
  decision that spans two adapters — out of scope here. What remains unverified is a narrower
  concern: because plan text lands in the turn's accumulated text, the reconciliation that matches
  a completed message payload against what was already streamed may fail its prefix check and drop
  the tail of a message. That interaction has not been reproduced and is not being fixed blind.

## Risks

- **Payload size.** Bundled fonts land in the packaged app. The set has to stay curated rather than
  exhaustive, or the installer grows noticeably.
- **New themes are the largest surface for a visual regression,** because a token that a theme
  leaves undefined silently inherits from the base palette and may go unnoticed until some rarely
  visited pane is opened in that theme.
- **The Codex transcript fix touches turn lifecycle code** shared with interrupt and error paths,
  which the existing tests cover only partly.
