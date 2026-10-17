#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef AppSource
  #error AppSource is required
#endif
#ifndef InstallerOutput
  #error InstallerOutput is required
#endif
#ifndef WebViewBootstrapper
  #error WebViewBootstrapper is required
#endif

[Setup]
; Keep this ID stable across updates, independent of the app version and path.
AppId={{72050252-5A9C-49C7-B73B-71A7DC8E1F45}
AppName=X動画ダウンローダー
AppVersion={#AppVersion}
AppPublisher=tanaka-note
DefaultDirName={localappdata}\Programs\XVideoDownloader
DefaultGroupName=X動画ダウンローダー
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir={#InstallerOutput}
OutputBaseFilename=XDownloader-Setup-{#AppVersion}-win-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\XDownloader.exe
UninstallDisplayName=X動画ダウンローダー
AppMutex=Local\XVideoDownloader.Installer.v1
SetupMutex=Local\XVideoDownloader.Setup.v1
; Never terminate a download or automatically restart the app during an update.
CloseApplications=no
RestartApplications=no
SetupLogging=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Tasks]
Name: "desktopicon"; Description: "デスクトップにショートカットを作成する"; GroupDescription: "ショートカット:"

[Files]
Source: "{#AppSource}\XDownloader.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSource}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSource}\THIRD-PARTY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#AppSource}\tools\*"; DestDir: "{app}\tools"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WebViewBootstrapper}"; Flags: dontcopy

[Icons]
Name: "{group}\X動画ダウンローダー"; Filename: "{app}\XDownloader.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\X動画ダウンローダー"; Filename: "{app}\XDownloader.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\XDownloader.exe"; Description: "X動画ダウンローダーを起動する"; Flags: nowait postinstall skipifsilent

[Code]
function HasWebView2: Boolean;
var
  Version: String;
  RuntimeKey: String;
begin
  RuntimeKey := 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := (RegQueryStringValue(HKLM32, RuntimeKey, 'pv', Version) and
    (Version <> '') and (Version <> '0.0.0.0'));
  if not Result then
    Result := (RegQueryStringValue(HKCU, RuntimeKey, 'pv', Version) and
      (Version <> '') and (Version <> '0.0.0.0'));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if HasWebView2 then exit;
  WizardForm.StatusLabel.Caption := 'ログイン画面に必要なMicrosoft WebView2をインストールしています...';
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  if Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '',
    SW_HIDE, ewWaitUntilTerminated, ExitCode) then
  begin
    if HasWebView2 then exit;
  end;
  Result := 'Microsoft WebView2を準備できませんでした。インターネット接続を確認して、セットアップをやり直してください。' + #13#10 +
    '解決しない場合は https://developer.microsoft.com/microsoft-edge/webview2/ からEvergreen Runtimeをインストールしてください。';
end;

// Deliberately no UninstallDelete: only installer-owned files are removed.
// Videos, settings.json and the protected login under LocalAppData are preserved.
