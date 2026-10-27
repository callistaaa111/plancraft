; Inno Setup script for PlanCraft.
; Build first:  python -m PyInstaller packaging/PlanCraft.spec --noconfirm --clean
; Then:         ISCC.exe /DAppVersion=1.0.0 packaging/PlanCraft.iss
; Output:       dist\installer\PlanCraft-Setup-<version>.exe

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

#define AppName "PlanCraft"
#define AppPublisher "PlanCraft"
#define AppURL "https://github.com/callistaaa111/plancraft"
#define AppExeName "PlanCraft.exe"

[Setup]
AppId={{5FB66CC1-0BF1-4AFC-B89D-638BECF32FA5}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} - offline takeoff
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\PlanCraft
DefaultGroupName=PlanCraft
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#SourcePath}\..\dist\installer
OutputBaseFilename=PlanCraft-Setup-{#AppVersion}
SetupIconFile={#SourcePath}\..\PlanCraft.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} {#AppVersion}
LicenseFile={#SourcePath}\..\LICENSE
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourcePath}\..\dist\PlanCraft\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\PlanCraft"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\PlanCraft"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,PlanCraft}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Projects live in {localappdata}\PlanCraft\data and are deliberately NOT removed by the uninstaller.
