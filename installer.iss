[Setup]
AppId={{ClaudeUsageTray}
AppName=ClaudeUsageTray
AppVersion={#AppVersion}
DefaultDirName={autopf}\ClaudeUsageTray
DefaultGroupName=ClaudeUsageTray
UninstallDisplayIcon={app}\ClaudeUsageTray.exe
OutputDir=.
OutputBaseFilename=ClaudeUsageTraySetup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
CloseApplicationsFilter=ClaudeUsageTray.exe

[Files]
Source: "publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs

[Tasks]
Name: "startup"; Description: "Run ClaudeUsageTray on Windows startup"; GroupDescription: "Additional options:"

[Icons]
Name: "{group}\ClaudeUsageTray"; Filename: "{app}\ClaudeUsageTray.exe"
Name: "{group}\Uninstall ClaudeUsageTray"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ClaudeUsageTray"; ValueData: """{app}\ClaudeUsageTray.exe"""; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\ClaudeUsageTray.exe"; Description: "Launch ClaudeUsageTray"; Flags: nowait postinstall
