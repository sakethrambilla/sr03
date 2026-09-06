# Installing sr03

Two ways to run it: from source, or as a packaged desktop app you build yourself. There are no
prebuilt releases — every installer is built locally from a clone.

## Prerequisites

- Node 22.16 or newer
- pnpm 11
- At least one local harness, installed and signed in: [Claude Code](https://claude.com/claude-code)
  or [Cursor CLI](https://cursor.com/cli) (as `cursor-agent` or `agent`)
- Building the `.dmg` requires macOS — Apple's disk-image format can only be created by macOS's own
  `hdiutil`, so `pnpm dmg` won't run anywhere else

## Run from source

```bash
git clone https://github.com/sakethrambilla/sr03.git
cd sr03
pnpm install
pnpm dev          # server :3399 + Vite :5399
open http://localhost:5399
```

This is the fastest way to try sr03 and the only way to get hot reload. No desktop shell, no
installer — just the dev server.

## Build a desktop installer

```bash
pnpm install
pnpm dmg          # macOS arm64 → desktop/dist/sr03-<version>-arm64.dmg
pnpm exe          # Windows x64 → desktop/dist/sr03-<version>-x64-setup.exe
```

Either command prints the final artifact path and size on its last line once done. `pnpm exe`
doesn't need Wine or a Windows machine to build the Windows installer.

### Installing the `.dmg` (macOS)

Neither installer is notarized by Apple, so Gatekeeper flags them on first launch.

1. Open the `.dmg` and drag `sr03` into `Applications`.
2. Launch it. macOS will refuse with "sr03 is damaged and can't be opened" or "can't be opened
   because Apple cannot check it for malicious software" — that's Gatekeeper, not a broken build.
3. Right-click (or Control-click) `sr03.app` in `Applications` and choose **Open**, then confirm in
   the dialog. This only has to be done once.
   - If that dialog doesn't appear, clear the quarantine flag instead:
     `xattr -cr /Applications/sr03.app`

### Installing the `.exe` (Windows)

The NSIS installer is unsigned, so Windows SmartScreen will warn on first run.

1. Run the installer. SmartScreen shows "Windows protected your PC".
2. Click **More info**, then **Run anyway**.
3. Follow the installer (per-user install, no admin required).

### After installing

Both variants share the machine's `~/.claude` and Cursor login — no separate sign-in inside sr03.
State (projects, threads, worktrees) lives in `~/.sr03` and is shared between a packaged install and
a `pnpm dev` instance running side by side.

See [README.md](README.md#configuration) for environment variables and
[README.md#what-is-stored-where](README.md#what-is-stored-where) for what ends up on disk.
