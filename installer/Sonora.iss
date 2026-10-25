; Windows installer for Sonora. Build the app first, then:
;   .venv\Scripts\pyinstaller --noconfirm Sonora.spec
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer\Sonora.iss
; The installer lands in installer\Output.

#define AppName "Sonora"
#define AppVersion "1.3.0"
#define AppExe "Sonora.exe"

[Setup]
AppId={{6E1C2F4B-8A57-4D9E-9B3A-5C0D7E21A9F3}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=MinecraftUser21
AppPublisherURL=https://github.com/MinecraftUser21/Sonora
AppSupportURL=https://github.com/MinecraftUser21/Sonora/issues
AppUpdatesURL=https://github.com/MinecraftUser21/Sonora/releases
; Installs for the current user without asking for admin; the dialog lets people pick all users instead
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=Output
OutputBaseFilename=Sonora-Setup-{#AppVersion}
SetupIconFile=..\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
LZMANumBlockThreads=4
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\dist\Sonora\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "THIRD_PARTY_NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

; Settings, sign-in cookies and the log in %APPDATA%\Sonora are left alone, so a reinstall keeps them

[Code]
const
  WebView2Key = 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2UserKey = 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2Url = 'https://developer.microsoft.com/microsoft-edge/webview2/#download';

function HasWebView2: Boolean;
var
  Version: String;
begin
  Result := (RegQueryStringValue(HKLM, WebView2Key, 'pv', Version) or
             RegQueryStringValue(HKCU, WebView2UserKey, 'pv', Version)) and
            (Version <> '') and (Version <> '0.0.0.0');
end;

// Sonora draws its window with Microsoft Edge WebView2. Windows 11 ships it; some Windows 10 PCs don't.
procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if (CurStep = ssPostInstall) and not HasWebView2 and not WizardSilent then
    if MsgBox('Sonora needs the Microsoft Edge WebView2 Runtime, which isn''t on this PC yet.' + #13#10#13#10 +
              'Open the download page now? Pick "Evergreen Bootstrapper", install it, then start Sonora.',
              mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', WebView2Url, '', '', SW_SHOWNORMAL, ewNoWait, Code);
end;
