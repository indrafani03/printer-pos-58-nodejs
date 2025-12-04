// Test direct printing to port instead of printer name
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Try printing directly to the port
const portName = '\\\\.\\CP002';  // Windows device path

// Simple test data
const testData = Buffer.from('\x1b@TEST DIRECT TO PORT\n\nHello from CP002!\n\n\n\n\x1dV\x00', 'binary');

const tempFile = path.join(__dirname, 'test_port.bin');
fs.writeFileSync(tempFile, testData);

console.log('Attempting to print directly to port:', portName);
console.log('Data size:', testData.length, 'bytes');

// Try method 1: Using type command to pipe to port
const cmd = `type "${tempFile}" > ${portName}`;
console.log('Command:', cmd);

exec(cmd, (error, stdout, stderr) => {
  console.log('Result:');
  if (stdout) console.log('stdout:', stdout);
  if (stderr) console.log('stderr:', stderr);
  if (error) {
    console.log('❌ Error:', error.message);
  } else {
    console.log('✅ Command succeeded');
  }

  // Cleanup
  try {
    fs.unlinkSync(tempFile);
  } catch (e) {}
});
