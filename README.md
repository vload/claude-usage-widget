# Claude Usage Widget

Monitor your Claude API usage from the Windows system tray and desktop. Two components: a **system tray app** (C#/.NET) and a **desktop companion** (Tauri/React) — a deformable blob that lives on your screen and changes color based on usage.

## Components

### Tray App (`ClaudeUsageTray/`)

System tray icon showing current usage percentage with popup details.

- Three icon styles (cycle via right-click menu): circle outline, rectangle fill bar, outside-in fill
- Left-click popup with per-section breakdowns (Current session, All models, Sonnet only, etc.)
- Per-section progress bars, reset times, and last-updated timestamp
- Auto-refreshes every 60 seconds
- Single-instance guard

### Companion Blob (`companion/`)

A soft-body deformable blob that floats on your desktop as a transparent overlay. It walks along window edges, jiggles, and can be dragged around like jelly.

- **Soft-body physics** — 14-node spring-mass pressure blob with Verlet integration. Squishy, bouncy, and deformable.
- **Jelly drag** — grab the blob and it deforms elastically around your cursor. Release and it snaps back with wobble.
- **Window awareness** — detects visible windows via Win32 API (DWM extended frame bounds, DWMWA_CLOAKED filtering). The blob walks along window edges and collides with them.
- **GlazeWM compatible** — correctly filters windows on inactive workspaces using DWMWA_CLOAKED.
- **Usage coloring** — blob color shifts from green → yellow → orange → red based on usage percentage. Inner color = current session, outer rim = weekly usage.
- **Click-through** — transparent overlay that passes mouse events through except when hovering the blob itself.
- **Speech bubble** — click the blob to see a usage breakdown popup.

## Prerequisites

- Windows 10/11
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — run `claude auth` to set up OAuth credentials

### Tray App

- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)

### Companion Blob

- [Node.js](https://nodejs.org/) (v18+) or [Bun](https://bun.sh/)
- [Rust](https://www.rust-lang.org/tools/install) (stable)

## Setup

### Tray App

```bash
dotnet run --project ClaudeUsageTray -c Release
```

The tray icon appears in the notification area (click the `^` arrow if hidden).

- **Hover** — tooltip with plan name, usage %, and reset time
- **Left-click** — popup with detailed per-section usage breakdown
- **Right-click → Refresh** — manually trigger a usage fetch
- **Right-click → Icon: ...** — cycle between icon styles (Circle, Rectangle, Fill)
- **Right-click → Exit** — close the app

### Companion Blob

```bash
cd companion
bun install        # or npm install
bunx tauri dev     # dev mode with hot-reload
```

To build a release:

```bash
cd companion
bunx tauri build
```

The built executable will be in `companion/src-tauri/target/release/`.

### Run on startup (optional)

Publish the tray app as a self-contained exe:

```bash
dotnet publish ClaudeUsageTray -c Release -r win-x64 --self-contained -o publish
```

Create a startup shortcut (PowerShell):

```powershell
$exePath = Resolve-Path ".\publish\ClaudeUsageTray.exe"
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ClaudeUsageTray.lnk")
$s.TargetPath = "$exePath"
$s.WorkingDirectory = Split-Path "$exePath"
$s.Save()
```

To remove from startup, delete the shortcut from `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`.

## How it works

Both components read OAuth credentials from `~/.claude/.credentials.json` (created by `claude auth`) and call the Anthropic usage API.

- **Tray App** — displays results as a tray icon with popup details. Auto-refreshes every 60 seconds.
- **Companion** — renders a soft-body blob on a transparent fullscreen overlay using Canvas 2D. The blob's color reflects usage levels. Physics runs at ~60fps with spring-mass constraints, pressure simulation, and gravity. Window positions are polled via Win32 `EnumWindows` + `DwmGetWindowAttribute` for accurate collision boundaries.

## Re-authenticating

If your credentials expire, the tray will show "Error" and the companion blob will show stale data. Run `claude auth` to refresh your OAuth credentials.

## Architecture

```
companion/
├── src/                    # React + TypeScript frontend
│   ├── App.tsx             # Main component, animation loop, mouse handlers
│   ├── canvas/
│   │   ├── physics.ts      # Verlet soft-body simulation (springs, pressure, walls)
│   │   ├── renderer.ts     # Canvas 2D drawing (triangulated mesh, usage gradients)
│   │   └── hitTest.ts      # Point-in-polygon for click detection
│   └── hooks/
│       ├── useUsage.ts         # Polls usage API
│       ├── useActiveWindow.ts  # Polls visible window rects via Tauri command
│       └── useClickThrough.ts  # Manages WS_EX_TRANSPARENT toggle
├── src-tauri/              # Rust backend (Tauri 2)
│   └── src/
│       ├── lib.rs          # App setup, window flags (WS_EX_TOOLWINDOW, transparent)
│       └── commands/
│           ├── usage.rs    # OAuth token refresh + usage API proxy
│           ├── windows.rs  # Win32 EnumWindows, DWM bounds, virtual desktop filtering
│           ├── cursor.rs   # Raw cursor position for click-through
│           └── hittest.rs  # Server-side hit test (unused, kept for reference)
```
