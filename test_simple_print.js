// Test script untuk cek apakah printer benar-benar print
const { SerialPort } = require('serialport');

const ESC = '\x1b';
const GS = '\x1d';

async function testPrint() {
  try {
    // List all ports
    const ports = await SerialPort.list();
    console.log("Available ports:");
    ports.forEach(p => {
      console.log(`  - ${p.path} (${p.manufacturer || 'Unknown'})`);
    });

    // Find printer port (modify this to your actual COM port)
    const printerPort = ports.find(p =>
      p.path.includes('COM') ||
      (p.manufacturer && p.manufacturer.toLowerCase().includes('prolific'))
    );

    if (!printerPort) {
      console.log("\n❌ No printer port found!");
      console.log("Please check if printer is connected and paired via Bluetooth");
      return;
    }

    console.log(`\n✅ Found printer port: ${printerPort.path}`);
    console.log(`\nConnecting to ${printerPort.path}...`);

    // Connect to printer
    const port = new SerialPort({
      path: printerPort.path,
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    });

    port.on('open', () => {
      console.log('✅ Connected to printer!\n');

      // Wait a bit before sending
      setTimeout(() => {
        console.log('Sending test print...\n');

        // Very simple test - just print a line
        const testData =
          ESC + '@' +                    // Initialize
          'HELLO FROM TEST SCRIPT\n' +   // Text
          '\n\n\n' +                     // Feed lines
          GS + 'V\x00';                  // Cut paper

        console.log('Data to send (hex):');
        console.log(testData.split('').map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' '));
        console.log('');

        port.write(testData, (err) => {
          if (err) {
            console.log('❌ Write error:', err.message);
            port.close();
            return;
          }

          console.log('✅ Data written to port');

          port.drain((drainErr) => {
            if (drainErr) {
              console.log('❌ Drain error:', drainErr.message);
            } else {
              console.log('✅ Data drained (sent to printer)');
            }

            console.log('\n🔍 Check your printer now! Did it print?');
            console.log('If nothing printed, the issue might be:');
            console.log('  1. Printer is not on/ready');
            console.log('  2. Wrong COM port selected');
            console.log('  3. Printer driver issue');
            console.log('  4. Bluetooth connection not stable');

            setTimeout(() => {
              port.close();
              console.log('\n✅ Test completed, port closed');
            }, 2000);
          });
        });
      }, 1000);
    });

    port.on('error', (err) => {
      console.log('❌ Serial port error:', err.message);
    });

  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

testPrint();
