/**
 * uninstall-service.js
 * Menghapus Thermal Printer Service dari Task Scheduler.
 *
 * Jalankan sebagai Administrator:
 *   node uninstall-service.js
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const TASK_NAME = 'ThermalPrinterService';
const BAT_FILE  = path.join(__dirname, 'start-service.bat');

function ps(command) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  return { stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), status: result.status };
}

// Cek Administrator
const adminCheck = ps('[bool](([System.Security.Principal.WindowsIdentity]::GetCurrent()).groups -match "S-1-5-32-544")');
if (adminCheck.stdout !== 'True') {
  console.error('✗ Harus dijalankan sebagai Administrator!');
  process.exit(1);
}

console.log('Menghapus ' + TASK_NAME + '...\n');

// Stop dulu jika sedang berjalan
ps(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue`);

// Hapus task
const exists = ps(`(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) -ne $null`);
if (exists.stdout === 'True') {
  const del = ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false`);
  if (del.status === 0) {
    console.log('✓ Task "' + TASK_NAME + '" dihapus dari Task Scheduler.');
  } else {
    console.error('✗ Gagal hapus task:', del.stderr);
  }
} else {
  console.log('⚠ Task "' + TASK_NAME + '" tidak ditemukan.');
}

// Hapus bat file
if (fs.existsSync(BAT_FILE)) {
  fs.unlinkSync(BAT_FILE);
  console.log('✓ File wrapper dihapus: ' + BAT_FILE);
}

// Hapus Windows Service lama jika masih ada
const oldSvc = ps(`(Get-Service -Name '${TASK_NAME}' -ErrorAction SilentlyContinue) -ne $null`);
if (oldSvc.stdout === 'True') {
  ps(`Stop-Service -Name '${TASK_NAME}' -Force -ErrorAction SilentlyContinue`);
  ps(`sc.exe delete '${TASK_NAME}'`);
  console.log('✓ Windows Service lama juga dihapus.');
}

console.log('\n✓ Uninstall selesai.');
