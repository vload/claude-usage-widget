$exePath = "G:\Projects\claude-usage\claude-usage-widget\publish\ClaudeUsageTray.exe"
$startupDir = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$shortcutPath = "$startupDir\ClaudeUsageTray.lnk"

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($shortcutPath)
$s.TargetPath = $exePath
$s.WorkingDirectory = Split-Path $exePath
$s.Description = "Claude Usage Tray Widget"
$s.Save()

Write-Host "Startup shortcut created at: $shortcutPath"
Write-Host "Target: $exePath"

# Also start it now
Start-Process $exePath
Write-Host "Tray app launched."
