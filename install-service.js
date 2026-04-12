/**
 * install-service.js
 * Mendaftarkan Thermal Printer Service menggunakan Windows Task Scheduler.
 * Lebih reliable daripada node-windows karena tidak bergantung pada WinSW wrapper.
 *
 * Jalankan sebagai Administrator:
 *   node install-service.js
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const TASK_NAME   = 'ThermalPrinterService';
const NODE_EXE    = process.execPath;                      // full path node.exe
const SCRIPT_PATH = path.join(__dirname, 'index.js');
const WORK_DIR    = __dirname;
const PORT        = '5000';

// ── Helpers ────────────────────────────────────────────────────────────────

function ps(command) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  return { stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), status: result.status };
}

function abort(msg) {
  console.error('\n✗ ' + msg);
  process.exit(1);
}

// ── Cek Administrator ──────────────────────────────────────────────────────

const adminCheck = ps('[bool](([System.Security.Principal.WindowsIdentity]::GetCurrent()).groups -match "S-1-5-32-544")');
if (adminCheck.stdout !== 'True') {
  abort('Script harus dijalankan sebagai Administrator!\n  Klik kanan PowerShell → "Run as administrator", lalu jalankan:\n  node install-service.js');
}

console.log('==============================================');
console.log(' Thermal Printer Service — Task Scheduler');
console.log('==============================================');
console.log('Node.js  : ' + NODE_EXE);
console.log('Script   : ' + SCRIPT_PATH);
console.log('Work dir : ' + WORK_DIR);
console.log('Port     : ' + PORT);
console.log('');

// ── Validasi file ──────────────────────────────────────────────────────────

if (!fs.existsSync(SCRIPT_PATH)) abort('index.js tidak ditemukan di: ' + SCRIPT_PATH);
if (!fs.existsSync(NODE_EXE))    abort('node.exe tidak ditemukan di: ' + NODE_EXE);

// ── Hapus task lama jika ada ───────────────────────────────────────────────

const existing = ps(`(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) -ne $null`);
if (existing.stdout === 'True') {
  console.log('⚠ Task "' + TASK_NAME + '" sudah ada. Menghapus dulu...');
  const del = ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`);
  if (del.status !== 0) abort('Gagal menghapus task lama:\n' + del.stderr);
  console.log('✓ Task lama dihapus.\n');
}

// Hapus juga Windows Service lama jika masih ada
const oldSvc = ps(`(Get-Service -Name '${TASK_NAME}' -ErrorAction SilentlyContinue) -ne $null`);
if (oldSvc.stdout === 'True') {
  console.log('⚠ Windows Service "' + TASK_NAME + '" ditemukan. Menghapus...');
  ps(`Stop-Service -Name '${TASK_NAME}' -Force -ErrorAction SilentlyContinue`);
  ps(`sc.exe delete '${TASK_NAME}'`);
  console.log('✓ Windows Service lama dihapus.\n');
}

// ── Buat wrapper .bat ──────────────────────────────────────────────────────
// Task Scheduler butuh executable — kita buat .bat yang launch node

const batPath = path.join(WORK_DIR, 'start-service.bat');
const batContent = [
  '@echo off',
  'set PORT=' + PORT,
  'set NODE_ENV=production',
  'cd /d "' + WORK_DIR + '"',
  '"' + NODE_EXE + '" "' + SCRIPT_PATH + '"',
].join('\r\n');

fs.writeFileSync(batPath, batContent, 'utf8');
console.log('✓ Wrapper dibuat: ' + batPath);

// ── Daftarkan Task Scheduler ────────────────────────────────────────────────

const psCmd = `
$action   = New-ScheduledTaskAction \`
              -Execute 'cmd.exe' \`
              -Argument '/c "${batPath.replace(/\\/g, '\\\\')}"' \`
              -WorkingDirectory '${WORK_DIR.replace(/\\/g, '\\\\')}';

$trigger  = New-ScheduledTaskTrigger -AtStartup;

$settings = New-ScheduledTaskSettingsSet \`
              -RestartCount 5 \`
              -RestartInterval (New-TimeSpan -Minutes 1) \`
              -StartWhenAvailable \`
              -ExecutionTimeLimit ([System.TimeSpan]::Zero);

$principal = New-ScheduledTaskPrincipal \`
              -UserId 'SYSTEM' \`
              -LogonType ServiceAccount \`
              -RunLevel Highest;

Register-ScheduledTask \`
  -TaskName '${TASK_NAME}' \`
  -Description 'Thermal Printer API Service (Node.js)' \`
  -Action $action \`
  -Trigger $trigger \`
  -Settings $settings \`
  -Principal $principal \`
  -Force | Out-Null;

Write-Output 'OK'
`;

console.log('\nMendaftarkan scheduled task...');
const reg = ps(psCmd);
if (reg.stdout !== 'OK' || reg.status !== 0) {
  abort('Gagal mendaftarkan task:\n' + reg.stderr + '\n' + reg.stdout);
}
console.log('✓ Task terdaftar.');

// ── Set delay 30 detik setelah boot (beri waktu sistem siap) ────────────────

const delayCmd = `
$task = Get-ScheduledTask -TaskName '${TASK_NAME}';
$task.Triggers[0].Delay = 'PT30S';
$task | Set-ScheduledTask | Out-Null;
Write-Output 'OK'
`;
const delay = ps(delayCmd);
if (delay.stdout === 'OK') {
  console.log('✓ Startup delay: 30 detik (beri waktu sistem & printer siap).');
} else {
  console.warn('⚠ Tidak bisa set delay (tidak kritis):', delay.stderr);
}

// ── Jalankan sekarang ───────────────────────────────────────────────────────

console.log('\nMenjalankan service...');
const start = ps(`Start-ScheduledTask -TaskName '${TASK_NAME}'`);
if (start.status !== 0) {
  console.warn('⚠ Tidak bisa start sekarang (akan start otomatis saat reboot):', start.stderr);
} else {
  // Tunggu sebentar lalu cek status
  execSync('timeout /t 3 /nobreak > nul', { shell: true });
  const status = ps(`(Get-ScheduledTask -TaskName '${TASK_NAME}').State`);
  console.log('✓ Status task: ' + status.stdout);
}

// Cek apakah node sudah berjalan
const running = ps(`Get-Process -Name 'node' -ErrorAction SilentlyContinue | Where-Object {$_.CommandLine -like '*index.js*'} | Measure-Object | Select-Object -ExpandProperty Count`);
if (parseInt(running.stdout) > 0) {
  console.log('✓ Node.js process berjalan!');
}

// ── Ringkasan ───────────────────────────────────────────────────────────────

console.log('');
console.log('==============================================');
console.log(' ✓ INSTALASI SELESAI');
console.log('==============================================');
console.log(' Task Name : ' + TASK_NAME);
console.log(' URL       : http://localhost:' + PORT);
console.log(' Node.js   : ' + NODE_EXE);
console.log(' Startup   : Otomatis (delay 30 detik)');
console.log(' Restart   : Otomatis jika crash (5x)');
console.log('');
console.log(' Kelola via Task Scheduler:');
console.log('   taskschd.msc → Task Scheduler Library');
console.log('   → "' + TASK_NAME + '"');
console.log('');
console.log(' Perintah manual:');
console.log('   Start  : schtasks /run /tn "' + TASK_NAME + '"');
console.log('   Stop   : schtasks /end /tn "' + TASK_NAME + '"');
console.log('   Hapus  : node uninstall-service.js');
