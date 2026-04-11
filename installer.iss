#define MyAppName "Thermal Printer Service"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Indrafani"
#define MyAppExeName "printer-service.exe"
#define MyServiceName "ThermalPrinterService"
#define MyServiceDisplayName "Thermal Printer Service"
#define MyAppPort "5000"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppContact=http://localhost:{#MyAppPort}
DefaultDirName={autopf}\PrinterService
DefaultGroupName={#MyAppName}
OutputDir=dist
OutputBaseFilename=PrinterServiceInstaller
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Main executable (compiled by pkg)
Source: "dist\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

; PowerShell script untuk raw printing
Source: "raw_print.ps1"; DestDir: "{app}"; Flags: ignoreversion

; Default config (hanya copy jika belum ada, agar setting tidak tertimpa saat update)
Source: "printer_config.json"; DestDir: "{app}"; Flags: ignoreversion onlyifdoesntexist

[Icons]
Name: "{group}\Open Services Manager"; Filename: "{sys}\services.msc"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; Daftarkan sebagai Windows Service dengan auto-start
Filename: "{sys}\sc.exe"; \
  Parameters: "create ""{#MyServiceName}"" binPath= """"""{app}\{#MyAppExeName}"""""" start= auto DisplayName= ""{#MyServiceDisplayName}"""; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Registering Windows Service..."

; Tambahkan deskripsi service
Filename: "{sys}\sc.exe"; \
  Parameters: "description ""{#MyServiceName}"" ""Thermal Printer API Service - REST API for thermal printer on port {#MyAppPort}"""; \
  Flags: runhidden waituntilterminated

; Set failure action: restart service jika crash
Filename: "{sys}\sc.exe"; \
  Parameters: "failure ""{#MyServiceName}"" reset= 86400 actions= restart/5000/restart/10000/restart/30000"; \
  Flags: runhidden waituntilterminated

; Jalankan service
Filename: "{sys}\sc.exe"; \
  Parameters: "start ""{#MyServiceName}"""; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Starting {#MyAppName}..."

[UninstallRun]
; Stop service sebelum uninstall
Filename: "{sys}\sc.exe"; \
  Parameters: "stop ""{#MyServiceName}"""; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "StopService"

; Hapus service saat uninstall
Filename: "{sys}\sc.exe"; \
  Parameters: "delete ""{#MyServiceName}"""; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "DeleteService"

[Code]

// Cek apakah service sudah ada, stop & hapus dulu sebelum install ulang
function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  // Stop service jika sedang berjalan (abaikan error)
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop "' + '{#MyServiceName}' + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(2000);

  // Hapus service lama jika ada (abaikan error)
  Exec(ExpandConstant('{sys}\sc.exe'), 'delete "' + '{#MyServiceName}' + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(1000);

  Result := True;
end;

// Tampilkan pesan sukses setelah install
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssDone then
  begin
    MsgBox(
      'Thermal Printer Service berhasil diinstall!' + #13#10 + #13#10 +
      'Service berjalan di: http://localhost:{#MyAppPort}' + #13#10 +
      'Service akan otomatis start setiap kali Windows dinyalakan.' + #13#10 + #13#10 +
      'Untuk mengelola service, buka: Services.msc' + #13#10 +
      'Cari: "{#MyServiceDisplayName}"',
      mbInformation, MB_OK
    );
  end;
end;
