# Claude Usage Tray

Monitor your Claude API usage from the Windows system tray.

```
scraper/scrape-usage.js  →  %APPDATA%/ClaudeUsageWidget/usage.json
                                     ↑
                            ClaudeUsageTray
                            (System Tray Icon)
```

## Prerequisites

- Windows 10/11
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- [Node.js](https://nodejs.org/)
- [Playwright](https://playwright.dev/) (Firefox)

## Setup

### 1. Install scraper dependencies

```bash
cd scraper
npm install
npx playwright install firefox
```

### 2. Authenticate with Claude

Run the scraper once manually — if you're not logged in, a Firefox window will open for you to sign in. Your session is saved to a persistent browser profile.

```bash
node scraper/scrape-usage.js
```

### 3. Run the system tray app

```bash
dotnet run --project ClaudeUsageTray -c Release
```

A tray icon appears in the notification area (click the `^` arrow if hidden).

- **Hover** — tooltip with plan name, usage %, and reset time
- **Left-click** — popup with detailed usage breakdown per section
- **Right-click → Refresh** — manually trigger a scrape
- **Right-click → Exit** — close the app

The app automatically runs the scraper every 60 seconds.

### 4. (Optional) Run on startup

First publish a self-contained exe:

```bash
dotnet publish ClaudeUsageTray -c Release -r win-x64 --self-contained -o ClaudeUsageTray/publish
```

Then create a startup shortcut (PowerShell):

```powershell
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ClaudeUsageTray.lnk")
$s.TargetPath = "FULL_PATH_TO\ClaudeUsageTray\publish\ClaudeUsageTray.exe"
$s.WorkingDirectory = "FULL_PATH_TO\ClaudeUsageTray\publish"
$s.Save()
```

Replace `FULL_PATH_TO` with the actual path to the project.

## How it works

1. The **scraper** (`scraper/scrape-usage.js`) uses Playwright Firefox to load `claude.ai/settings/usage`, parse the usage percentages, and write the result to `%APPDATA%/ClaudeUsageWidget/usage.json`.

2. The **tray app** (`ClaudeUsageTray/`) reads that JSON file and displays:
   - A bar icon (white background, orange fill) showing overall usage
   - A popup window with per-section progress bars, reset times, and last-updated timestamp

## Project structure

```
ClaudeUsageTray/   C# WinForms system tray app
scraper/           Node.js + Playwright scraper
```
