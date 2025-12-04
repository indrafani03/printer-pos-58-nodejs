// Test script to detect USB printers
const usb = require('usb');

console.log("\n=== Scanning for USB Devices ===\n");

try {
  const devices = usb.getDeviceList();

  console.log(`Found ${devices.length} USB devices\n`);

  // Common vendor IDs for thermal printers
  const printerVendors = {
    0x0483: 'STMicroelectronics',
    0x04b8: 'Seiko Epson',
    0x0416: 'Winbond Electronics',
    0x0525: 'Netchip Technology',
    0x1504: 'Tulip Computers',
    0x154f: 'Wintec Industries',
    0x1659: 'Prolific',
    0x1fc9: 'NXP Semiconductors',
    0x2109: 'VIA Labs',
    0x258a: 'Gamemax',
    0x26f1: 'Generic USB',
    0x0711: 'Magic Control Technology',
    0x1a86: 'QinHeng Electronics (CH340)',
    0x067b: 'Prolific Technology',
    0x0fe6: 'ICS Advent',
    0x0519: 'Star Micronics'
  };

  const printerDevices = [];

  devices.forEach((device, index) => {
    const vendorId = device.deviceDescriptor.idVendor;
    const productId = device.deviceDescriptor.idProduct;

    console.log(`Device ${index + 1}:`);
    console.log(`  Vendor ID: 0x${vendorId.toString(16).padStart(4, '0')}`);
    console.log(`  Product ID: 0x${productId.toString(16).padStart(4, '0')}`);

    if (printerVendors[vendorId]) {
      console.log(`  Manufacturer: ${printerVendors[vendorId]}`);
    }

    // Try to open device to get more info
    try {
      device.open();

      try {
        const manufacturer = device.deviceDescriptor.iManufacturer
          ? device.getStringDescriptor(device.deviceDescriptor.iManufacturer)
          : null;
        const product = device.deviceDescriptor.iProduct
          ? device.getStringDescriptor(device.deviceDescriptor.iProduct)
          : null;

        if (manufacturer) console.log(`  Manufacturer String: ${manufacturer}`);
        if (product) console.log(`  Product String: ${product}`);

      } catch (e) {
        // Silently ignore descriptor errors
      }

      device.close();

      // Check if it's likely a printer (Class 7 = Printer)
      const deviceClass = device.deviceDescriptor.bDeviceClass;
      const deviceSubClass = device.deviceDescriptor.bDeviceSubClass;

      console.log(`  Device Class: ${deviceClass}`);
      console.log(`  Device SubClass: ${deviceSubClass}`);

      if (deviceClass === 7 || deviceClass === 255) {
        console.log(`  ✅ Potential Printer Device!`);
        printerDevices.push({ vendorId, productId, index });
      }

    } catch (error) {
      console.log(`  (Could not open device: ${error.message})`);
    }

    console.log('');
  });

  console.log("\n=== Summary ===");
  console.log(`Total USB devices: ${devices.length}`);
  console.log(`Potential printers found: ${printerDevices.length}`);

  if (printerDevices.length > 0) {
    console.log("\nPrinter devices:");
    printerDevices.forEach(p => {
      console.log(`  - Vendor: 0x${p.vendorId.toString(16).padStart(4, '0')}, Product: 0x${p.productId.toString(16).padStart(4, '0')}`);
    });
  }

} catch (error) {
  console.error("Error scanning USB devices:", error.message);
}
