const Service = require('node-windows').Service;
const path = require('path');
const { execSync } = require('child_process');

const SERVICE_NAME = 'ThermalPrinterService';
const SERVICE_DISPLAY = 'Thermal Printer Service';

// Create a new service object
const svc = new Service({
  name: SERVICE_NAME,
  description: 'API service for thermal printer operations (RPP02N)',
  script: path.join(__dirname, 'index.js'),

  // Full path to node.exe agar tidak bergantung pada PATH system
  execPath: process.execPath,

  // Working directory eksplisit
  workingDirectory: __dirname,

  // Restart otomatis jika crash: tunggu 3 detik, max 10x retry
  wait: 3,
  grow: 0.5,
  maxRetries: 10,

  nodeOptions: [
    '--max_old_space_size=512'
  ],

  env: [
    { name: 'PORT',     value: '5000' },
    { name: 'NODE_ENV', value: 'production' }
  ]
});

svc.on('install', function () {
  console.log('✓ Service installed successfully!');

  // Set startup type ke Automatic dan konfigurasi recovery via sc.exe
  try {
    // Startup Automatic (delayed) agar sistem sudah siap
    execSync(`sc config "${SERVICE_NAME}" start= delayed-auto`, { stdio: 'pipe' });
    console.log('✓ Startup type set to: Automatic (Delayed)');
  } catch (e) {
    console.warn('⚠ Could not set startup type (try running as Administrator):', e.message);
  }

  try {
    // Recovery: restart service setelah 5 detik jika gagal (3 kali)
    execSync(
      `sc failure "${SERVICE_NAME}" reset= 86400 actions= restart/5000/restart/5000/restart/5000`,
      { stdio: 'pipe' }
    );
    console.log('✓ Failure recovery configured (auto-restart on crash)');
  } catch (e) {
    console.warn('⚠ Could not set failure recovery:', e.message);
  }

  console.log('\n✓ Starting service...');
  svc.start();
});

svc.on('start', function () {
  console.log('✓ Service started successfully!');
  console.log('');
  console.log('  Service Name : ' + SERVICE_NAME);
  console.log('  Display Name : ' + SERVICE_DISPLAY);
  console.log('  Node Path    : ' + process.execPath);
  console.log('  Script       : ' + path.join(__dirname, 'index.js'));
  console.log('  URL          : http://localhost:5000');
  console.log('');
  console.log('  Manage via:');
  console.log('    services.msc  → "' + SERVICE_DISPLAY + '"');
  console.log('    Task Manager  → Services tab');
  console.log('');

  // Verifikasi status lewat sc.exe
  try {
    const status = execSync(`sc query "${SERVICE_NAME}"`, { encoding: 'utf8' });
    const match = status.match(/STATE\s+:\s+\d+\s+(\w+)/);
    if (match) console.log('  Current State: ' + match[1]);
  } catch (e) { /* ignore */ }
});

svc.on('alreadyinstalled', function () {
  console.log('⚠ Service is already installed.');
  console.log('  Run: node uninstall-service.js   to remove it first.');
});

svc.on('error', function (err) {
  console.error('✗ Error:', err);
});

// Install
console.log('Installing ' + SERVICE_DISPLAY + '...');
console.log('Node.js path: ' + process.execPath);
console.log('Script path : ' + path.join(__dirname, 'index.js'));
console.log('Please wait...\n');
svc.install();
