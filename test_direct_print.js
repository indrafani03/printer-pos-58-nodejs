// Test direct printing to Windows printer
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const printerName = 'POS58(2)';

// Simple test data
const testData = '\x1b@TEST PRINT\n\nHello World!\n\n\n\n\x1dV\x00';

const tempFile = path.join(__dirname, 'test_direct.bin');

// Write test data
fs.writeFileSync(tempFile, testData, 'binary');

console.log('Test data written to:', tempFile);
console.log('File size:', fs.statSync(tempFile).size, 'bytes');

// Method 1: Using copy command
console.log('\n=== Method 1: copy /B ===');
const cmd1 = `copy /B "${tempFile}" "${printerName}"`;
console.log('Command:', cmd1);

exec(cmd1, (error, stdout, stderr) => {
  console.log('stdout:', stdout);
  console.log('stderr:', stderr);
  if (error) {
    console.log('error:', error.message);
  } else {
    console.log('✅ Copy command succeeded');
  }

  // Cleanup
  try {
    fs.unlinkSync(tempFile);
  } catch (e) {}
});
