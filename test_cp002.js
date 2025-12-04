// Test script to connect to CP002 port
const { SerialPort } = require('serialport');

async function testCP002() {
  console.log("\n=== Testing CP002 Port ===\n");

  // First, list all ports
  try {
    const ports = await SerialPort.list();
    console.log("All ports detected by serialport:");
    ports.forEach((port, i) => {
      console.log(`${i + 1}. ${port.path} - ${port.manufacturer || 'Unknown'}`);
    });
    console.log('');
  } catch (error) {
    console.error("Error listing ports:", error.message);
  }

  // Try to connect to CP002
  console.log("Attempting to connect to CP002...");

  const testPort = new SerialPort({
    path: 'CP002',
    baudRate: 9600,
    autoOpen: false
  });

  testPort.on('error', (err) => {
    console.error("Port error:", err.message);
  });

  testPort.open((err) => {
    if (err) {
      console.error("Failed to open CP002:", err.message);

      // Try with \\.\CP002 (Windows device naming)
      console.log("\nTrying with Windows device path: \\\\.\\CP002");

      const testPort2 = new SerialPort({
        path: '\\\\.\\CP002',
        baudRate: 9600,
        autoOpen: false
      });

      testPort2.on('error', (err) => {
        console.error("Port error:", err.message);
      });

      testPort2.open((err2) => {
        if (err2) {
          console.error("Failed to open \\\\.\\CP002:", err2.message);
          console.log("\n❌ Could not connect to printer via CP002 port");
          console.log("The printer may be using USB Printer Class (not serial)");
        } else {
          console.log("✅ Successfully opened \\\\.\\CP002");
          testPort2.close();
        }
      });
    } else {
      console.log("✅ Successfully opened CP002");
      testPort.close();
    }
  });
}

testCP002();
