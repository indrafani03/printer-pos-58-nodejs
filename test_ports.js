// Test script to see all available ports
const { SerialPort } = require('serialport');

async function scanAllPorts() {
  try {
    const ports = await SerialPort.list();
    console.log("\n=== ALL AVAILABLE PORTS ===\n");

    if (ports.length === 0) {
      console.log("❌ No ports found at all!");
    } else {
      ports.forEach((port, index) => {
        console.log(`Port ${index + 1}:`);
        console.log(`  Path: ${port.path}`);
        console.log(`  Manufacturer: ${port.manufacturer || 'Unknown'}`);
        console.log(`  Serial Number: ${port.serialNumber || 'N/A'}`);
        console.log(`  PnP ID: ${port.pnpId || 'N/A'}`);
        console.log(`  Vendor ID: ${port.vendorId || 'N/A'}`);
        console.log(`  Product ID: ${port.productId || 'N/A'}`);
        console.log('');
      });
    }

    console.log("\n=== PORT ANALYSIS ===\n");

    // Show which would be filtered
    const filtered = ports.filter(port => {
      const path = port.path.toLowerCase();
      const manufacturer = (port.manufacturer || '').toLowerCase();

      return path.includes('com') ||
             path.includes('tty') ||
             path.includes('usb') ||
             manufacturer.includes('prolific') ||
             manufacturer.includes('bluetooth') ||
             manufacturer.includes('ftdi');
    });

    console.log(`Total ports: ${ports.length}`);
    console.log(`Filtered ports (current logic): ${filtered.length}`);

    if (filtered.length > 0) {
      console.log("\nFiltered ports:");
      filtered.forEach(p => console.log(`  - ${p.path} (${p.manufacturer || 'Unknown'})`));
    }

  } catch (error) {
    console.error("Error scanning ports:", error);
  }
}

scanAllPorts();
