const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'Thermal Printer Service',
  script: path.join(__dirname, 'index.js')
});

// Listen for the "uninstall" event
svc.on('uninstall', function(){
  console.log('✓ Service uninstalled successfully!');
  console.log('  The service has been removed from Windows Services.');
  console.log('  It will no longer start automatically on boot.');
});

// Listen for errors
svc.on('error', function(err){
  console.error('✗ Error:', err);
});

svc.on('doesnotexist', function(){
  console.log('⚠ Service does not exist.');
  console.log('  Nothing to uninstall.');
});

// Uninstall the service
console.log('Uninstalling Thermal Printer Service...');
console.log('Please wait...\n');
svc.uninstall();
