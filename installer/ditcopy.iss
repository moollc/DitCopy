; Windows installer for DitCopy, built by the release workflow with Inno Setup.
; It installs for the current user (no administrator prompt) and adds Start menu shortcuts.
#define AppVersion GetEnv("DITCOPY_VERSION")
#define BundleDir GetEnv("DITCOPY_BUNDLE")
#define OutDir GetEnv("DITCOPY_OUT")

[Setup]
AppId={{6D5B1C38-3F6E-4D2B-9A57-D17C0DE70001}
AppName=DitCopy
AppVersion={#AppVersion}
AppPublisher=moollc
AppPublisherURL=https://github.com/moollc/DitCopy
DefaultDirName={autopf}\DitCopy
DefaultGroupName=DitCopy
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=DitCopy-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#BundleDir}\icon.ico
UninstallDisplayIcon={app}\icon.ico
DisableProgramGroupPage=yes
LicenseFile={#BundleDir}\LICENSE

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\DitCopy"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"
Name: "{group}\Stop DitCopy"; Filename: "{app}\stop.bat"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"
Name: "{autodesktop}\DitCopy"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Add a shortcut to the desktop"; Flags: unchecked

[Run]
Filename: "{app}\start.bat"; WorkingDir: "{app}"; Description: "Start DitCopy now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\stop.bat"; WorkingDir: "{app}"; Flags: runhidden; RunOnceId: "StopDitCopy"
