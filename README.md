# Claude Usage Tray

Monitor your Claude API usage from the Windows system tray. Reads OAuth credentials from Claude Code CLI and queries the Anthropic API directly.

## Features

- System tray icon with a fill bar showing current usage percentage
- Left-click popup with per-section breakdowns (Current session, All models, Sonnet only, etc.)
- Per-section progress bars, reset times, and last-updated timestamp
- Auto-refreshes every 60 seconds
- Manual refresh from right-click menu

## Prerequisites

- Windows 10/11
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — run `claude auth` to set up OAuth credentials

## Setup

```bash
dotnet run --project ClaudeUsageTray -c Release
```

The tray icon appears in the notification area (click the `^` arrow if hidden).

- **Hover** — tooltip with plan name, usage %, and reset time
- **Left-click** — popup with detailed per-section usage breakdown
- **Right-click → Refresh** — manually trigger a usage fetch
- **Right-click → Exit** — close the app

### Run on startup (optional)

Publish a self-contained exe:

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

The app reads OAuth credentials from `~/.claude/.credentials.json` (created by `claude auth`), calls the Anthropic usage API, and displays the results as a tray icon with an orange fill bar. Left-clicking shows a popup with per-section progress bars. Auto-refreshes every 60 seconds.

## Re-authenticating

If your credentials expire, the tray will show "Error". Run `claude auth` to refresh your OAuth credentials.
