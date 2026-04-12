const Service = require('node-windows').Service;
const path = require('path');

const SERVICE_NAME = 'ThermalPrinterService';

const svc = new Service({
  name: SERVICE_NAME,
  script: path.join(__dirname, 'index.js')
});

svc.on('uninstall', function () {
  console.log('✓ Service uninstalled successfully!');
  console.log('  "' + SERVICE_NAME + '" has been removed from Windows Services.');
});

svc.on('doesnotexist', function () {
  console.log('⚠ Service "' + SERVICE_NAME + '" does not exist. Nothing to uninstall.');
});

svc.on('error', function (err) {
  console.error('✗ Error:', err);
});

console.log('Uninstalling ' + SERVICE_NAME + '...\n');
svc.uninstall();
