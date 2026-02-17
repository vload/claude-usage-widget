# Claude Usage Tray

Monitor your Claude API usage from the Windows system tray. A headless Playwright scraper fetches usage data from claude.ai and a WinForms tray app displays it.

## Features

- System tray icon with a fill bar showing current usage percentage
- Left-click popup with per-section breakdowns (Current session, All models, Sonnet only, etc.)
- Per-section progress bars, reset times, and last-updated timestamp
- Auto-refreshes every 60 seconds via headless browser scrape
- Manual refresh from right-click menu

## Prerequisites

- Windows 10/11
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Node.js](https://nodejs.org/)

## Setup

### 1. Install scraper dependencies

```bash
cd scraper
npm install
npx playwright install firefox
```

### 2. Run the tray app

```bash
dotnet run --project ClaudeUsageTray -c Release
```

The tray icon appears in the notification area (click the `^` arrow if hidden).

- **Hover** — tooltip with plan name, usage %, and reset time
- **Left-click** — popup with detailed per-section usage breakdown
- **Right-click → Refresh** — manually trigger a scrape
- **Right-click → Login** — open a visible browser to (re-)authenticate with Claude
- **Right-click → Exit** — close the app

On first launch, right-click the tray icon and click **Login** to open a browser and sign in to Claude. The session is saved for future headless scrapes.

### 3. Run on startup (optional)

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

1. **Scraper** (`scraper/scrape-usage.js`) — Uses Playwright Firefox to load `claude.ai/settings/usage` headlessly, parses the usage percentages from the page, and writes the result to `%APPDATA%/ClaudeUsageWidget/usage.json`. Pass `--login` to open a visible browser for authentication.

2. **Tray app** (`ClaudeUsageTray/`) — Reads `usage.json` and displays a tray icon with an orange fill bar proportional to usage. Left-clicking shows a popup with per-section progress bars. The app runs the scraper automatically every 60 seconds.

## Re-authenticating

If your session expires, the tray will show "Error". Right-click the tray icon and click **Login** to re-authenticate.

## Project structure

```
ClaudeUsageTray/   C# WinForms system tray app
scraper/           Node.js + Playwright Firefox scraper
```
