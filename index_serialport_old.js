// Install dependencies (tanpa bluetooth-serial-port):
// npm install express serialport cors

const express = require('express');
const { SerialPort } = require('serialport');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

const app = express();
app.use(express.json());
app.use(cors());

// Global variables
let currentPort = null;
let serialPort = null;
let autoReconnectEnabled = true;
let reconnectInterval = null;
let lastConnectedPort = null;

// ESC/POS Commands
const ESC = '\x1b';
const commands = {
  INIT: ESC + '@',
  ALIGN_CENTER: ESC + 'a\x01',
  ALIGN_LEFT: ESC + 'a\x00',
  ALIGN_RIGHT: ESC + 'a\x02',
  BOLD_ON: ESC + 'E\x01',
  BOLD_OFF: ESC + 'E\x00',
  CUT: '\x1d\x56\x00',  // GS V 0 - Full cut
  NEW_LINE: '\n',
  FEED_LINE: ESC + 'd\x01',
  DOUBLE_HEIGHT: ESC + '!\x10',
  NORMAL_SIZE: ESC + '!\x00',
  UNDERLINE_ON: ESC + '-\x01',
  UNDERLINE_OFF: ESC + '-\x00',
  CHARSET_LATIN: ESC + 't\x00',
  CHARSET_PC437: ESC + 't\x01',
  CODEPAGE_LATIN1: ESC + 't\x03'
};

// Function untuk mencari port printer dengan prioritas USB/Bluetooth
async function scanPorts() {
  try {
    const ports = await SerialPort.list();
    console.log("Available ports:", ports.map(p => ({
      path: p.path,
      manufacturer: p.manufacturer || 'Unknown',
      vendorId: p.vendorId,
      productId: p.productId
    })));

    // Filter untuk bluetooth/USB printer ports
    const printerPorts = ports.filter(port => {
      const path = port.path.toLowerCase();
      const manufacturer = (port.manufacturer || '').toLowerCase();

      return path.includes('com') || // Windows COM ports
        path.includes('tty') || // Unix/Linux tty ports
        path.includes('usb') ||
        manufacturer.includes('prolific') ||
        manufacturer.includes('bluetooth') ||
        manufacturer.includes('ftdi');
    });

    // Prioritas: USB terlebih dahulu, kemudian Bluetooth
    printerPorts.sort((a, b) => {
      const aPath = a.path.toLowerCase();
      const bPath = b.path.toLowerCase();
      const aManufacturer = (a.manufacturer || '').toLowerCase();
      const bManufacturer = (b.manufacturer || '').toLowerCase();

      // USB devices get higher priority
      const aIsUSB = aPath.includes('usb') || aManufacturer.includes('prolific') || aManufacturer.includes('ftdi');
      const bIsUSB = bPath.includes('usb') || bManufacturer.includes('prolific') || bManufacturer.includes('ftdi');

      if (aIsUSB && !bIsUSB) return -1;
      if (!aIsUSB && bIsUSB) return 1;

      // Bluetooth devices get second priority
      const aIsBluetooth = aManufacturer.includes('bluetooth');
      const bIsBluetooth = bManufacturer.includes('bluetooth');

      if (aIsBluetooth && !bIsBluetooth) return -1;
      if (!aIsBluetooth && bIsBluetooth) return 1;

      return 0;
    });

    return printerPorts;
  } catch (error) {
    console.error("Error scanning ports:", error);
    return [];
  }
}

// Function untuk connect ke printer
async function connectPrinter(portPath, options = {}) {
  return new Promise((resolve, reject) => {
    if (serialPort && serialPort.isOpen) {
      serialPort.close();
    }

    const defaultOptions = {
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: false,
      autoOpen: false
    };

    const config = { ...defaultOptions, ...options };

    serialPort = new SerialPort({
      path: portPath,
      ...config
    });

    serialPort.open((err) => {
      if (err) {
        reject(new Error(`Failed to open port ${portPath}: ${err.message}`));
        return;
      }

      currentPort = portPath;
      lastConnectedPort = portPath;
      console.log(`Connected to printer on ${portPath}`);

      // Test connection dengan init command
      serialPort.write(commands.INIT, (writeErr) => {
        if (writeErr) {
          reject(new Error(`Failed to initialize printer: ${writeErr.message}`));
          return;
        }
        resolve(true);
      });
    });

    // Handle disconnection
    serialPort.on('close', () => {
      console.log('⚠️  Printer disconnected');
      currentPort = null;
      if (autoReconnectEnabled) {
        console.log('🔄 Auto-reconnect enabled, will attempt to reconnect...');
        startReconnectMonitor();
      }
    });

    serialPort.on('error', (err) => {
      console.error('Serial port error:', err);
      if (autoReconnectEnabled) {
        startReconnectMonitor();
      }
    });
  });
}

// Function untuk print raw data
async function printRaw(data) {
  return new Promise((resolve, reject) => {
    if (!serialPort || !serialPort.isOpen) {
      reject(new Error("Printer not connected"));
      return;
    }

    serialPort.write(data, (err) => {
      if (err) {
        reject(new Error(`Print failed: ${err.message}`));
        return;
      }

      // Wait for data to be sent
      serialPort.drain((drainErr) => {
        if (drainErr) {
          reject(new Error(`Drain failed: ${drainErr.message}`));
          return;
        }
        resolve("Print successful");
      });
    });
  });
}

// Function untuk format text ke 32 karakter (58mm paper)
function formatLine(left, right = '', width = 32) {
  const leftStr = left.toString().substring(0, width - right.length);
  const rightStr = right.toString();
  const spaces = ' '.repeat(Math.max(0, width - leftStr.length - rightStr.length));
  return leftStr + spaces + rightStr;
}

// Function untuk create receipt text
function createReceiptText(data) {
  // Handle both old format (direct properties) and new format (nested receiptData)
  const receiptData = data.receiptData || data;

  const {
    store = {},
    receiptNumber = "",
    orderNumber = "",
    customerName = "",
    customerPhone = "",
    items = [],
    subtotal = 0,
    ppnAmount = 0,
    discountAmount = 0,
    totalAmount = 0,
    paymentMethod = "",
    cashReceived = 0,
    cashChange = 0,
    paymentDate = "",
    // Backward compatibility
    storeName = store.name || "TOKO SAYA",
    storeAddress = store.address || "",
    total = totalAmount || 0,
    payment = cashReceived || 0,
    change = cashChange || 0,
    cashier = "",
    transactionId = receiptNumber || orderNumber || ""
  } = receiptData;

  let receipt = commands.INIT;
  receipt += commands.CHARSET_PC437; // Set to PC437 (standard ASCII)
  receipt += commands.CODEPAGE_LATIN1; // Ensure Latin character set

  // Header
  receipt += commands.ALIGN_CENTER;
  receipt += commands.BOLD_ON;
  receipt += cleanText(store.name || storeName) + commands.NEW_LINE;
  receipt += commands.BOLD_OFF;

  const address = store.address || storeAddress;
  if (address) {
    // Split long address into multiple lines for better formatting
    const cleanAddress = cleanText(address);
    const addressLines = cleanAddress.match(/.{1,30}(\s|$)/g) || [cleanAddress];
    addressLines.forEach(line => {
      receipt += cleanText(line.trim()) + commands.NEW_LINE;
    });
  }

  if (store.phone) {
    receipt += "Tel: " + cleanText(store.phone) + commands.NEW_LINE;
  }

  receipt += "================================" + commands.NEW_LINE;
  receipt += commands.ALIGN_LEFT;
  receipt += commands.NEW_LINE;

  // Transaction info
  receipt += "Tanggal: " + cleanText(paymentDate || new Date().toLocaleString('id-ID')) + commands.NEW_LINE;
  if (receiptNumber) receipt += "No. Struk: " + cleanText(receiptNumber) + commands.NEW_LINE;
  if (orderNumber) receipt += "No. Order: " + cleanText(orderNumber) + commands.NEW_LINE;
  if (cashier) receipt += "Kasir: " + cleanText(cashier) + commands.NEW_LINE;
  if (customerName) receipt += "Customer: " + cleanText(customerName) + commands.NEW_LINE;
  if (customerPhone) receipt += "Telp: " + cleanText(customerPhone) + commands.NEW_LINE;
  receipt += "--------------------------------" + commands.NEW_LINE;

  // Items header
  receipt += formatLine("Item", "Qty  Harga") + commands.NEW_LINE;
  receipt += "--------------------------------" + commands.NEW_LINE;

  // Items
  items.forEach(item => {
    const name = cleanText(item.name || "").substring(0, 28);
    const qty = parseInt(item.quantity || item.qty || 0);
    const price = item.price || 0;

    // Calculate item subtotal (base price only)
    const itemSubtotal = price * qty;

    receipt += name + commands.NEW_LINE;
    receipt += formatLine(`  ${qty} x ${formatRupiah(price)}`, formatRupiah(itemSubtotal)) + commands.NEW_LINE;

    // Add finishings if exists
    let finishingTotal = 0;
    if (item.finishings && Array.isArray(item.finishings) && item.finishings.length > 0) {
      item.finishings.forEach(finishing => {
        const finishingName = cleanText(finishing.name || "").substring(0, 24);
        const finishingQty = finishing.quantity || 1;
        const finishingPrice = finishing.price || 0;
        const finishingItemTotal = finishingPrice * (finishing.multiplyByQty ? qty : 1) * finishingQty;
        finishingTotal += finishingItemTotal;

        receipt += formatLine(`    + ${finishingName}`, formatRupiah(finishingItemTotal)) + commands.NEW_LINE;
      });
    }

    // Add notes if exists
    if (item.notes) {
      const notes = cleanText(item.notes).substring(0, 28);
      receipt += `    Note: ${notes}` + commands.NEW_LINE;
    }

    // Show item total with finishings if there are any
    if (finishingTotal > 0) {
      const itemTotal = itemSubtotal + finishingTotal;
      receipt += formatLine("  Subtotal item:", formatRupiah(itemTotal)) + commands.NEW_LINE;
    }
  });

  receipt += "--------------------------------" + commands.NEW_LINE;

  // Totals
  if (subtotal > 0 && subtotal !== totalAmount) {
    receipt += formatLine("Subtotal:", formatRupiah(subtotal)) + commands.NEW_LINE;
  }

  if (ppnAmount > 0) {
    receipt += formatLine("PPN:", formatRupiah(ppnAmount)) + commands.NEW_LINE;
  }

  if (discountAmount > 0) {
    receipt += formatLine("Diskon:", "-" + formatRupiah(discountAmount)) + commands.NEW_LINE;
  }

  receipt += commands.BOLD_ON;
  receipt += formatLine("TOTAL:", formatRupiah(totalAmount || total)) + commands.NEW_LINE;
  receipt += commands.BOLD_OFF;

  if (paymentMethod) {
    receipt += formatLine("Metode:", cleanText(paymentMethod)) + commands.NEW_LINE;
  }

  if ((cashReceived || payment) > 0) {
    receipt += formatLine("Bayar:", formatRupiah(cashReceived || payment)) + commands.NEW_LINE;
  }

  if ((cashChange || change) > 0) {
    receipt += formatLine("Kembali:", formatRupiah(cashChange || change)) + commands.NEW_LINE;
  }

  receipt += commands.NEW_LINE;
  receipt += commands.ALIGN_CENTER;
  receipt += "Terima Kasih!" + commands.NEW_LINE;
  receipt += "Selamat Berbelanja Kembali" + commands.NEW_LINE;
  receipt += commands.NEW_LINE;
  receipt += commands.FEED_LINE;
  receipt += commands.FEED_LINE;
  receipt += commands.CUT;

  return receipt;
}

// Helper function untuk clean text
function cleanText(text) {
  return text
    .replace(/[^\x20-\x7E\n\r]/g, '') // Remove non-ASCII printable characters
    .replace(/[\x00-\x1F]/g, '') // Remove control characters except \n and \r
    .trim();
}

// Helper function untuk format rupiah
function formatRupiah(amount) {
  const formatted = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0
  }).format(amount).replace('IDR', 'Rp');

  return cleanText(formatted);
}

// Floyd-Steinberg dithering algorithm
function floydSteinbergDithering(pixels, width, height) {
  const output = new Uint8Array(pixels.length);

  // Copy original data
  for (let i = 0; i < pixels.length; i++) {
    output[i] = pixels[i];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const oldPixel = output[index];
      const newPixel = oldPixel < 128 ? 0 : 255;
      output[index] = newPixel;

      const error = oldPixel - newPixel;

      // Distribute error to neighboring pixels
      if (x + 1 < width) {
        output[index + 1] += error * 7 / 16;
      }
      if (y + 1 < height) {
        if (x > 0) {
          output[index + width - 1] += error * 3 / 16;
        }
        output[index + width] += error * 5 / 16;
        if (x + 1 < width) {
          output[index + width + 1] += error * 1 / 16;
        }
      }
    }
  }

  return output;
}

// Function to convert image to ESC/POS raster format
async function imageToRaster(imageUrl, maxWidth = 384) {
  try {
    // Download image
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data);

    // Process image with better quality settings
    let { data, info } = await sharp(imageBuffer)
      .resize(maxWidth, null, {
        fit: 'inside',
        kernel: 'lanczos3'
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .grayscale()
      .normalise() // Better contrast enhancement
      .linear(1.2, -(128 * 0.2)) // Increase contrast
      .raw()
      .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;

    // Apply Floyd-Steinberg dithering for better quality
    data = floydSteinbergDithering(data, width, height);

    // Convert to ESC/POS raster format
    let rasterData = '';

    // ESC/POS raster bit image command: GS v 0
    const widthBytes = Math.ceil(width / 8);
    const xL = widthBytes & 0xFF;
    const xH = (widthBytes >> 8) & 0xFF;
    const yL = height & 0xFF;
    const yH = (height >> 8) & 0xFF;

    rasterData += '\x1D\x76\x30\x00'; // GS v 0 m
    rasterData += String.fromCharCode(xL, xH, yL, yH);

    // Convert pixels to raster bytes
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < widthBytes; x++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const pixelX = x * 8 + bit;
          if (pixelX < width) {
            const pixelIndex = (y * width + pixelX);
            const pixelValue = data[pixelIndex];
            // If pixel is black (0), set bit to 1
            if (pixelValue === 0) {
              byte |= (1 << (7 - bit));
            }
          }
        }
        rasterData += String.fromCharCode(byte);
      }
    }

    return rasterData;
  } catch (error) {
    throw new Error(`Failed to process image: ${error.message}`);
  }
}

// Function untuk start reconnect monitor
function startReconnectMonitor() {
  if (reconnectInterval) {
    return; // Already monitoring
  }

  console.log('🔍 Starting reconnect monitor...');

  reconnectInterval = setInterval(async () => {
    // Check if already connected
    if (serialPort && serialPort.isOpen) {
      console.log('✅ Printer already connected, stopping reconnect monitor');
      stopReconnectMonitor();
      return;
    }

    console.log('🔄 Attempting to reconnect to printer...');
    try {
      const ports = await scanPorts();

      if (ports.length === 0) {
        console.log('❌ No printer ports found');
        return;
      }

      // Try to connect to last known port first
      if (lastConnectedPort) {
        const lastPort = ports.find(p => p.path === lastConnectedPort);
        if (lastPort) {
          console.log(`🔗 Reconnecting to last known port: ${lastConnectedPort}`);
          await connectPrinter(lastConnectedPort);
          console.log('✅ Reconnected successfully!');
          stopReconnectMonitor();
          return;
        }
      }

      // Try first available port
      console.log(`🔗 Connecting to ${ports[0].path}...`);
      await connectPrinter(ports[0].path);
      console.log('✅ Connected successfully!');
      stopReconnectMonitor();

    } catch (error) {
      console.log(`❌ Reconnect attempt failed: ${error.message}`);
    }
  }, 5000); // Try every 5 seconds
}

// Function untuk stop reconnect monitor
function stopReconnectMonitor() {
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
    reconnectInterval = null;
    console.log('⏹️  Reconnect monitor stopped');
  }
}

// Function untuk auto-connect dengan retry mechanism
async function autoConnectWithRetry(maxRetries = 3) {
  console.log("\n🔍 Scanning for printer ports...");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const ports = await scanPorts();

      if (ports.length === 0) {
        console.log(`❌ No printer ports found (attempt ${attempt}/${maxRetries})`);
        if (attempt < maxRetries) {
          console.log(`⏳ Waiting 3 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }
        throw new Error("No printer ports found after all retries");
      }

      console.log(`Found ${ports.length} port(s):`, ports.map(p => `${p.path} (${p.manufacturer || 'Unknown'})`).join(', '));

      // Try to connect to each port in order of priority
      for (const port of ports) {
        try {
          console.log(`🔗 Attempting to connect to ${port.path}...`);
          await connectPrinter(port.path);
          console.log(`✅ Auto-connected to printer on ${port.path}`);
          return true;
        } catch (error) {
          console.log(`❌ Failed to connect to ${port.path}: ${error.message}`);
        }
      }

      if (attempt < maxRetries) {
        console.log(`⏳ All ports failed, waiting 3 seconds before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

    } catch (error) {
      console.log(`❌ Auto-connect attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  console.log("❌ Auto-connect failed after all retries");
  console.log("📝 Make sure your RPP02N is:");
  console.log("   - Turned on");
  console.log("   - Paired via Windows Bluetooth settings (for Bluetooth)");
  console.log("   - Properly connected via USB (for USB connection)");
  console.log("📝 You can manually connect later using POST /printer/connect");

  // Start monitoring for when printer becomes available
  if (autoReconnectEnabled) {
    console.log("🔄 Starting auto-reconnect monitor...");
    startReconnectMonitor();
  }

  return false;
}

// ===========================================
// API ENDPOINTS
// ===========================================

// Scan available ports
app.get('/printer/ports', async (req, res) => {
  try {
    const ports = await scanPorts();
    res.json({
      success: true,
      ports: ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || 'Unknown',
        vendorId: p.vendorId,
        productId: p.productId
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to scan ports",
      error: error.message
    });
  }
});

// Connect to printer
app.post('/printer/connect', async (req, res) => {
  try {
    const { port, baudRate = 9600 } = req.body;

    if (!port) {
      // Auto-detect
      const ports = await scanPorts();
      if (ports.length === 0) {
        return res.status(400).json({
          success: false,
          message: "No printer ports found. Make sure printer is paired and connected."
        });
      }

      // Try first available port
      await connectPrinter(ports[0].path, { baudRate });

      res.json({
        success: true,
        message: "Printer connected successfully",
        port: ports[0].path
      });
    } else {
      await connectPrinter(port, { baudRate });

      res.json({
        success: true,
        message: "Printer connected successfully",
        port: port
      });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to connect to printer",
      error: error.message
    });
  }
});

// Check printer status
app.get('/printer/status', (req, res) => {
  res.json({
    success: true,
    connected: serialPort && serialPort.isOpen,
    port: currentPort,
    lastConnectedPort: lastConnectedPort,
    autoReconnectEnabled: autoReconnectEnabled,
    isMonitoring: reconnectInterval !== null
  });
});

// Disconnect printer
app.post('/printer/disconnect', (req, res) => {
  try {
    const { disableAutoReconnect = false } = req.body;

    if (disableAutoReconnect) {
      autoReconnectEnabled = false;
      stopReconnectMonitor();
      console.log('🔴 Auto-reconnect disabled');
    }

    if (serialPort && serialPort.isOpen) {
      serialPort.close();
    }
    currentPort = null;
    serialPort = null;

    res.json({
      success: true,
      message: "Printer disconnected",
      autoReconnectEnabled: autoReconnectEnabled
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to disconnect",
      error: error.message
    });
  }
});

// Enable/disable auto-reconnect
app.post('/printer/auto-reconnect', (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: "enabled parameter must be a boolean"
      });
    }

    autoReconnectEnabled = enabled;

    if (enabled) {
      console.log('🟢 Auto-reconnect enabled');
      // If printer is not connected, start monitoring
      if (!serialPort || !serialPort.isOpen) {
        startReconnectMonitor();
      }
    } else {
      console.log('🔴 Auto-reconnect disabled');
      stopReconnectMonitor();
    }

    res.json({
      success: true,
      message: `Auto-reconnect ${enabled ? 'enabled' : 'disabled'}`,
      autoReconnectEnabled: autoReconnectEnabled
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to change auto-reconnect setting",
      error: error.message
    });
  }
});

// Print receipt directly without popup window
app.get('/print/receipt', async (req, res) => {
  try {
    console.log("Serial port check:", !!serialPort, serialPort ? serialPort.isOpen : 'N/A');

    // Auto-connect if not connected
    if (!serialPort || !serialPort.isOpen) {
      console.log("Printer not connected, attempting auto-connect...");
      try {
        const ports = await scanPorts();
        if (ports.length === 0) {
          return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Print Error</title>
              <meta charset="UTF-8">
              <style>
                body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
                .error { color: #f44336; font-size: 20px; margin-bottom: 20px; }
                .instruction { color: #666; font-size: 14px; margin-bottom: 20px; }
              </style>
            </head>
            <body>
              <div class="error">❌ Tidak ada printer yang ditemukan!</div>
              <div class="instruction">Pastikan printer RPP02N sudah dipasangkan via Bluetooth</div>
              <script>
                setTimeout(() => {
                  if (window.opener) {
                    window.opener.focus();
                    window.close();
                  } else {
                    window.close();
                  }
                }, 3000);
              </script>
            </body>
            </html>
          `);
        }

        // Try to connect to first available port
        await connectPrinter(ports[0].path);
        console.log("Auto-connected successfully to:", ports[0].path);
      } catch (autoConnectError) {
        console.error("Auto-connect failed:", autoConnectError.message);
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>Print Error</title>
            <meta charset="UTF-8">
            <style>
              body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
              .error { color: #f44336; font-size: 20px; margin-bottom: 20px; }
              .instruction { color: #666; font-size: 14px; margin-bottom: 20px; }
            </style>
          </head>
          <body>
            <div class="error">❌ Gagal menghubungkan ke printer!</div>
            <div class="instruction">${autoConnectError.message}</div>
            <script>
              setTimeout(() => {
                if (window.opener) {
                  window.opener.focus();
                  window.close();
                } else {
                  window.close();
                }
              }, 3000);
            </script>
          </body>
          </html>
        `);
      }
    }

    // Debug: log the received query parameters
    console.log("Received query parameters:", req.query);

    // Parse the data parameter if it exists (URL-encoded JSON)
    let receiptData = req.query;
    if (req.query.data) {
      try {
        receiptData = JSON.parse(decodeURIComponent(req.query.data));
        console.log("Parsed JSON data from query parameter:", receiptData);
      } catch (parseError) {
        console.error("Failed to parse JSON data from query parameter:", parseError.message);
        throw new Error("Invalid JSON data in query parameter");
      }
    }

    console.log("Creating receipt text...");
    const receiptText = createReceiptText(receiptData);
    console.log("Receipt text created successfully");

    // Debug: log the generated receipt text
    console.log("Generated receipt text length:", receiptText.length);
    console.log("Receipt text preview:", receiptText.substring(0, 100));
    console.log("About to print receipt...");

    try {
      await printRaw(receiptText);
      console.log("Print completed successfully!");
    } catch (printError) {
      console.log("Print failed:", printError.message);
      throw printError;
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print Complete</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .success { color: #4CAF50; font-size: 20px; margin-bottom: 15px; }
          .closing { color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="success">✅ Print berhasil!</div>
        <div class="closing">Menutup dalam 2 detik...</div>
        <script>
          setTimeout(() => {
            if (window.opener) {
              window.opener.focus();
              window.close();
            } else {
              window.close();
            }
          }, 2000);
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error("Print error:", error);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print Error</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .error { color: #f44336; font-size: 20px; margin-bottom: 15px; }
          .message { color: #666; font-size: 14px; margin-bottom: 15px; }
          .closing { color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="error">❌ Print gagal!</div>
        <div class="message">${error.message}</div>
        <div class="closing">Menutup dalam 3 detik...</div>
        <script>
          setTimeout(() => {
            if (window.opener) {
              window.opener.focus();
              window.close();
            } else {
              window.close();
            }
          }, 3000);
        </script>
      </body>
      </html>
    `);
  }
});

// Direct print - the actual print endpoint
app.get('/print/receipt/direct', async (req, res) => {
  try {
    console.log("Serial port check:", !!serialPort, serialPort ? serialPort.isOpen : 'N/A');

    if (!serialPort || !serialPort.isOpen) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Print Error</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            .error { color: #f44336; font-size: 20px; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <div class="error">❌ Printer tidak terhubung!</div>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body>
        </html>
      `);
    }

    // Debug: log the received query parameters
    console.log("Received query parameters:", req.query);

    // Parse the data parameter if it exists (URL-encoded JSON)
    let receiptData = req.query;
    if (req.query.data) {
      try {
        receiptData = JSON.parse(decodeURIComponent(req.query.data));
        console.log("Parsed JSON data from query parameter:", receiptData);
      } catch (parseError) {
        console.error("Failed to parse JSON data from query parameter:", parseError.message);
        throw new Error("Invalid JSON data in query parameter");
      }
    }

    console.log("Creating receipt text...");
    const receiptText = createReceiptText(receiptData);
    console.log("Receipt text created successfully");

    // Debug: log the generated receipt text
    console.log("Generated receipt text length:", receiptText.length);
    console.log("Receipt text preview:", receiptText.substring(0, 100));
    console.log("About to print receipt...");

    try {
      await printRaw(receiptText);
      console.log("Print completed successfully!");
    } catch (printError) {
      console.log("Print failed:", printError.message);
      throw printError;
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print Complete</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .success { color: #4CAF50; font-size: 20px; margin-bottom: 15px; }
          .closing { color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="success">✅ Print berhasil!</div>
        <div class="closing">Menutup dalam 2 detik...</div>
        <script>
          setTimeout(() => {
            window.close();
          }, 2000);
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error("Print error:", error);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print Error</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .error { color: #f44336; font-size: 20px; margin-bottom: 15px; }
          .message { color: #666; font-size: 14px; margin-bottom: 15px; }
          .closing { color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="error">❌ Print gagal!</div>
        <div class="message">${error.message}</div>
        <div class="closing">Menutup dalam 3 detik...</div>
        <script>
          setTimeout(() => {
            window.close();
          }, 3000);
        </script>
      </body>
      </html>
    `);
  }
});

// Debug endpoint to check receipt generation
app.get('/debug/receipt', (req, res) => {
  console.log("Debug - Received query parameters:", req.query);

  // Parse the data parameter if it exists (URL-encoded JSON)
  let receiptData = req.query;
  if (req.query.data) {
    try {
      receiptData = JSON.parse(decodeURIComponent(req.query.data));
      console.log("Debug - Parsed JSON data from query parameter:", receiptData);
    } catch (parseError) {
      console.error("Debug - Failed to parse JSON data:", parseError.message);
      return res.status(400).json({
        error: "Invalid JSON data in query parameter",
        parseError: parseError.message
      });
    }
  }

  const receiptText = createReceiptText(receiptData);

  console.log("Debug - Generated receipt text length:", receiptText.length);
  console.log("Debug - Receipt text:", receiptText);

  res.json({
    query: req.query,
    receiptTextLength: receiptText.length,
    receiptText: receiptText,
    receiptTextPreview: receiptText.substring(0, 200) + "..."
  });
});

// Raw print
app.post('/print/raw', async (req, res) => {
  try {
    if (!serialPort || !serialPort.isOpen) {
      return res.status(400).json({
        success: false,
        message: "Printer not connected"
      });
    }

    const { text, escCommands = [] } = req.body;

    let printData = commands.INIT;

    // Apply ESC commands
    escCommands.forEach(cmd => {
      if (commands[cmd]) {
        printData += commands[cmd];
      }
    });

    if (text) {
      printData += text + commands.NEW_LINE;
    }

    printData += commands.FEED_LINE + commands.CUT;

    await printRaw(printData);

    res.json({
      success: true,
      message: "Raw print successful"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Raw print failed",
      error: error.message
    });
  }
});

// Test print
app.post('/print/test', async (req, res) => {
  try {
    if (!serialPort || !serialPort.isOpen) {
      return res.status(400).json({
        success: false,
        message: "Printer not connected"
      });
    }

    let testData = commands.INIT;
    testData += commands.ALIGN_CENTER;
    testData += commands.DOUBLE_HEIGHT;
    testData += commands.BOLD_ON;
    testData += "TEST PRINT" + commands.NEW_LINE;
    testData += commands.BOLD_OFF;
    testData += commands.NORMAL_SIZE;
    testData += commands.ALIGN_LEFT;
    testData += commands.NEW_LINE;
    testData += "Printer: RPP02N" + commands.NEW_LINE;
    testData += "Connection: " + currentPort + commands.NEW_LINE;
    testData += "Time: " + new Date().toLocaleString('id-ID') + commands.NEW_LINE;
    testData += commands.NEW_LINE;
    testData += commands.ALIGN_CENTER;
    testData += "Print berhasil!" + commands.NEW_LINE;
    testData += commands.NEW_LINE;
    testData += commands.FEED_LINE;
    testData += commands.CUT;

    await printRaw(testData);

    res.json({
      success: true,
      message: "Test print successful"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Test print failed",
      error: error.message
    });
  }
});

// Print text only
app.post('/print/text', async (req, res) => {
  try {
    if (!serialPort || !serialPort.isOpen) {
      return res.status(400).json({
        success: false,
        message: "Printer not connected"
      });
    }

    const { text = "" } = req.body;

    let printData = commands.INIT;
    printData += text + commands.NEW_LINE;
    printData += commands.FEED_LINE;
    printData += commands.CUT;

    await printRaw(printData);

    res.json({
      success: true,
      message: "Text printed successfully"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Text print failed",
      error: error.message
    });
  }
});

// Print image from URL
app.post('/print/image', async (req, res) => {
  try {
    if (!serialPort || !serialPort.isOpen) {
      return res.status(400).json({
        success: false,
        message: "Printer not connected"
      });
    }

    const { imageUrl, maxWidth = 384 } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: "imageUrl is required"
      });
    }

    console.log(`Processing image from: ${imageUrl}`);

    // Convert image to raster format
    const rasterData = await imageToRaster(imageUrl, maxWidth);

    // Prepare print data
    let printData = commands.INIT;
    printData += commands.ALIGN_CENTER;
    printData += rasterData;
    printData += commands.NEW_LINE;
    printData += commands.FEED_LINE;
    printData += commands.CUT;

    await printRaw(printData);

    res.json({
      success: true,
      message: "Image printed successfully"
    });

  } catch (error) {
    console.error("Image print error:", error);
    res.status(500).json({
      success: false,
      message: "Image print failed",
      error: error.message
    });
  }
});

// Print image from URL via GET (for easy testing)
app.get('/print/image', async (req, res) => {
  try {
    if (!serialPort || !serialPort.isOpen) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Print Error</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            .error { color: #f44336; font-size: 20px; }
          </style>
        </head>
        <body>
          <div class="error">❌ Printer tidak terhubung!</div>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body>
        </html>
      `);
    }

    const { imageUrl, maxWidth = 384 } = req.query;

    if (!imageUrl) {
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Print Error</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
            .error { color: #f44336; font-size: 20px; }
          </style>
        </head>
        <body>
          <div class="error">❌ imageUrl parameter required!</div>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body>
        </html>
      `);
    }

    console.log(`Processing image from: ${imageUrl}`);

    // Convert image to raster format
    const rasterData = await imageToRaster(imageUrl, parseInt(maxWidth));

    // Prepare print data
    let printData = commands.INIT;
    printData += commands.ALIGN_CENTER;
    printData += rasterData;
    printData += commands.NEW_LINE;
    printData += commands.FEED_LINE;
    printData += commands.CUT;

    await printRaw(printData);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print Complete</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .success { color: #4CAF50; font-size: 20px; }
        </style>
      </head>
      <body>
        <div class="success">✅ Gambar berhasil diprint!</div>
        <script>setTimeout(() => window.close(), 2000);</script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error("Image print error:", error);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print Error</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .error { color: #f44336; font-size: 20px; margin-bottom: 15px; }
          .message { color: #666; font-size: 14px; }
        </style>
      </head>
      <body>
        <div class="error">❌ Print gambar gagal!</div>
        <div class="message">${error.message}</div>
        <script>setTimeout(() => window.close(), 3000);</script>
      </body>
      </html>
    `);
  }
});

// Error handler
app.use((error, req, res, next) => {
  console.error("Server error:", error);
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: error.message
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  stopReconnectMonitor();
  if (serialPort && serialPort.isOpen) {
    serialPort.close(() => {
      console.log('Printer disconnected');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🖨️  Printer API Server running on port ${PORT}`);
  console.log("\n📋 Available endpoints:");
  console.log("GET  /printer/ports - Scan available ports");
  console.log("POST /printer/connect - Connect to printer");
  console.log("GET  /printer/status - Check printer status");
  console.log("POST /printer/disconnect - Disconnect printer");
  console.log("POST /printer/auto-reconnect - Enable/disable auto-reconnect");
  console.log("GET  /print/receipt - Print receipt");
  console.log("POST /print/raw - Raw print with ESC commands");
  console.log("POST /print/test - Test print");
  console.log("POST /print/text - Print simple text");
  console.log("GET/POST /print/image - Print image from URL");
  console.log("\n🔧 Auto-Connect Features:");
  console.log("✅ Auto-connect on startup (USB/Bluetooth priority)");
  console.log("✅ Auto-reconnect on disconnection");
  console.log("✅ Background monitoring for printer availability");
  console.log("✅ Retry mechanism with multiple attempts");
  console.log("\n🔧 Setup Instructions:");
  console.log("1. For Bluetooth: Pair your RPP02N via Windows Bluetooth settings");
  console.log("2. For USB: Connect your printer via USB cable");
  console.log("3. Server will automatically connect (USB has priority)");
  console.log("4. If connection fails, server will keep retrying in background");
});

// Start auto-connect process with retry mechanism
setTimeout(() => autoConnectWithRetry(3), 1000);