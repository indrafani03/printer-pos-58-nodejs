const Service = require('node-windows').Service;
const path = require('path');

// Create a new service object
const svc = new Service({
  name: 'Thermal Printer Service',
  description: 'API service for thermal printer operations (RPP02N)',
  script: path.join(__dirname, 'index.js'),
  nodeOptions: [
    '--harmony',
    '--max_old_space_size=4096'
  ],
  env: [
    {
      name: "PORT",
      value: "5000"
    },
    {
      name: "NODE_ENV",
      value: "production"
    }
  ]
});

// Listen for the "install" event
svc.on('install', function(){
  console.log('✓ Service installed successfully!');
  console.log('✓ Starting service...');
  svc.start();
});

// Listen for the "start" event
svc.on('start', function(){
  console.log('✓ Service started successfully!');
  console.log('  Service Name: Thermal Printer Service');
  console.log('  Server running on: http://localhost:5000');
  console.log('\nYou can manage this service from:');
  console.log('  - Services.msc (Windows Services)');
  console.log('  - Task Manager > Services tab');
});

// Listen for errors
svc.on('alreadyinstalled', function(){
  console.log('⚠ Service is already installed.');
  console.log('  Please uninstall first using: node uninstall-service.js');
});

svc.on('error', function(err){
  console.error('✗ Error:', err);
});

// Install the service
console.log('Installing Thermal Printer Service...');
console.log('Please wait...\n');
svc.install();
