# Live slash-command list

## Problem
Skills added or removed on the machine don't show up in sr03's "/" menu. A `mermaid` plugin skill
installed on 2026-09-24 appears for only one of seven folders — the only one whose cached list was
refreshed after the install. The page asks the server once per load, the server answers from a
stale cache and refreshes it silently in the background, and that refresh merges into the old
list, so nothing ever disappears either. Every user who installs a skill hits this.

## Goal
The "/" menu reflects the skills and commands installed on the machine as of the latest background
refresh, for Claude, Cursor and Codex, without restarting or reloading the app.

## Non-goals
- A thread whose CLI is already running keeps the skill set it started with; the menu shows that
  session's own list. Parking/resuming picks up new skills.
- No filesystem watching of skill directories.
- No change to how skills are invoked, or to the menu's look.
- No change to the set of directories each provider scans.

## Behaviour
Each time the user opens the "/" menu, the page asks the server for the folder's list. The server
answers immediately from its cache (so the menu opens instantly) and starts a background refresh
if none is in flight. When the refresh finishes, the server replaces its cached list with the fresh
one and pushes it to every open page, which updates the menu in place if it's open.

If the background refresh fails (CLI missing, timeout), the cached list stays as-is, the error is
logged, and nothing is pushed.

## Acceptance criteria
1. When a skill directory is added under the user's skills root and the user presses "/" in a
   folder with no running thread, the skill appears in the menu within one background refresh,
   without reloading the page.
2. When a skill is deleted from disk, after the next refresh the menu no longer lists it.
3. When a plugin skill is installed (visible only through the CLI's live list), after the next
   refresh the menu lists it (e.g. `mermaid:mermaid-skill`).
4. When the menu is open while a refresh lands, the list updates without closing the menu.
5. When the background refresh fails, the menu keeps showing the previous list and no push is sent.
6. When "/" is pressed repeatedly while a refresh is in flight, only one refresh runs per
   provider and folder.
7. Criteria 1–5 hold for Claude, Cursor and Codex.

## Constraints
- A cold refresh spawns a whole provider process, so it must never block the menu opening.
- Command lists are keyed per provider and folder; two providers in one folder must not overwrite
  each other.
- Server/web wire event types must stay mirrored.

## Open questions
None outstanding.
