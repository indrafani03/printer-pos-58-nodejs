// Windows Printer API untuk POS58
// Menggunakan PowerShell untuk print langsung ke Windows printer

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());
app.use(cors());

// Configuration
const DEFAULT_PRINTER = 'POS58'; // Nama printer Windows Anda
let currentPrinter = DEFAULT_PRINTER;
let availablePrinters = [];
let autoReconnectEnabled = false; // Default disabled untuk hemat kertas
let reconnectInterval = null;

// ESC/POS Commands (will be converted to text formatting)
const ESC = '\x1b';
const commands = {
  INIT: ESC + '@',
  ALIGN_CENTER: ESC + 'a\x01',
  ALIGN_LEFT: ESC + 'a\x00',
  ALIGN_RIGHT: ESC + 'a\x02',
  BOLD_ON: ESC + 'E\x01',
  BOLD_OFF: ESC + 'E\x00',
  CUT: '\x1d\x56\x00',
  NEW_LINE: '\n',
  FEED_LINE: ESC + 'd\x01',
  DOUBLE_HEIGHT: ESC + '!\x10',
  NORMAL_SIZE: ESC + '!\x00',
};

// Function untuk scan printer yang tersedia
function scanPrinters() {
  return new Promise((resolve, reject) => {
    exec('powershell "Get-Printer | Where-Object {$_.PrinterStatus -eq \'Normal\'} | Select-Object Name, PortName, DriverName | ConvertTo-Json"', (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to scan printers:', error.message);
        resolve([]);
        return;
      }

      try {
        const printers = JSON.parse(stdout);
        const printerList = Array.isArray(printers) ? printers : [printers];

        // Filter untuk printer POS/thermal
        const filteredPrinters = printerList.filter(p => {
          const name = (p.Name || '').toLowerCase();
          const driver = (p.DriverName || '').toLowerCase();
          const port = (p.PortName || '').toLowerCase();

          // Prioritas printer thermal (POS, thermal, ESC/POS)
          return name.includes('pos') ||
                 name.includes('thermal') ||
                 driver.includes('pos') ||
                 driver.includes('thermal') ||
                 port.includes('cp');  // CP ports untuk USB thermal printers
        });

        // Jika tidak ada printer thermal, return semua printer normal
        const result = filteredPrinters.length > 0 ? filteredPrinters : printerList;

        resolve(result.map(p => ({
          name: p.Name,
          port: p.PortName,
          driver: p.DriverName
        })));
      } catch (e) {
        console.error('Failed to parse printers:', e.message);
        resolve([]);
      }
    });
  });
}

// Function untuk test printer connectivity (tanpa print kertas)
function testPrinter(printerName) {
  return new Promise((resolve) => {
    // Cek status printer via PowerShell tanpa print
    exec(`powershell "Get-Printer -Name '${printerName}' | Select-Object PrinterStatus"`, {
      timeout: 3000
    }, (error, stdout, stderr) => {
      if (error || stderr) {
        resolve(false);
        return;
      }

      // Cek jika printer status Normal
      if (stdout.includes('Normal')) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

// Function untuk auto-connect ke printer yang tersedia
async function autoConnectPrinter() {
  console.log('\n🔍 Scanning for available printers...');

  try {
    const printers = await scanPrinters();
    availablePrinters = printers;

    if (printers.length === 0) {
      console.log('❌ No printers found');
      return false;
    }

    console.log(`✅ Found ${printers.length} printer(s):`);
    printers.forEach((p, i) => {
      console.log(`   ${i + 1}. ${p.name} (${p.port}) - ${p.driver}`);
    });

    // Try to connect to first available printer
    const firstPrinter = printers[0];
    console.log(`\n🔗 Attempting to connect to: ${firstPrinter.name}`);

    // Test printer
    const isWorking = await testPrinter(firstPrinter.name);

    if (isWorking) {
      currentPrinter = firstPrinter.name;
      console.log(`✅ Successfully connected to: ${currentPrinter}`);
      return true;
    } else {
      console.log(`⚠️  Printer ${firstPrinter.name} found but not responding`);

      // Try other printers
      for (let i = 1; i < printers.length; i++) {
        console.log(`🔗 Trying: ${printers[i].name}`);
        const works = await testPrinter(printers[i].name);

        if (works) {
          currentPrinter = printers[i].name;
          console.log(`✅ Successfully connected to: ${currentPrinter}`);
          return true;
        }
      }

      console.log('❌ No working printers found');
      return false;
    }
  } catch (error) {
    console.error('❌ Auto-connect failed:', error.message);
    return false;
  }
}

// Function untuk start reconnect monitor
function startReconnectMonitor() {
  if (reconnectInterval) {
    return; // Already monitoring
  }

  console.log('🔄 Starting reconnect monitor...');

  reconnectInterval = setInterval(async () => {
    console.log('🔄 Checking printer connection...');

    const isWorking = await testPrinter(currentPrinter);

    if (!isWorking) {
      console.log('⚠️  Printer disconnected, attempting reconnect...');
      await autoConnectPrinter();
    } else {
      console.log('✅ Printer still connected');
    }
  }, 30000); // Check every 30 seconds
}

// Function untuk stop reconnect monitor
function stopReconnectMonitor() {
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
    reconnectInterval = null;
    console.log('⏹️  Reconnect monitor stopped');
  }
}

// Function untuk print ke Windows printer menggunakan raw data via Win32 API
function printToWindowsPrinter(printerName, data) {
  return new Promise((resolve, reject) => {
    // Create temp file dengan raw data
    const tempFile = path.join(os.tmpdir(), `print_${Date.now()}.bin`);

    try {
      // Write binary data to file
      fs.writeFileSync(tempFile, data, 'binary');
    } catch (err) {
      reject(new Error(`Failed to create temp file: ${err.message}`));
      return;
    }

    // Use the raw_print.ps1 script
    const rawPrintScript = path.join(__dirname, 'raw_print.ps1');

    // Execute PowerShell raw printing
    exec(`powershell -ExecutionPolicy Bypass -File "${rawPrintScript}" -PrinterName "${printerName}" -DataFile "${tempFile}"`, {
      timeout: 30000
    }, (error, stdout, stderr) => {
      // Cleanup
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (e) {
        console.log('Cleanup warning:', e.message);
      }

      if (error) {
        console.error('Print error:', error.message);
        console.error('stderr:', stderr);
        reject(new Error(`Print failed: ${error.message}`));
        return;
      }

      if (stdout.includes('Print successful')) {
        console.log('Print completed successfully');
        resolve('Print successful');
      } else {
        console.error('Print output:', stdout);
        console.error('Print stderr:', stderr);
        reject(new Error(`Print failed: ${stderr || 'Unknown error'}`));
      }
    });
  });
}

// Helper functions (sama seperti sebelumnya)
function formatLine(left, right = '', width = 32) {
  const leftStr = left.toString().substring(0, width - right.length);
  const rightStr = right.toString();
  const spaces = ' '.repeat(Math.max(0, width - leftStr.length - rightStr.length));
  return leftStr + spaces + rightStr;
}

function cleanText(text) {
  return text
    .replace(/[^\x20-\x7E\n\r]/g, '')
    .replace(/[\x00-\x1F]/g, '')
    .trim();
}

function formatRupiah(amount) {
  const formatted = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0
  }).format(amount).replace('IDR', 'Rp');
  return cleanText(formatted);
}

function createReceiptText(data) {
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
    additionalServiceValue = 0,
    additionalServiceNotes = "",
    totalAmount = 0,
    paymentMethod = "",
    cashReceived = 0,
    cashChange = 0,
    paymentDate = "",
    storeName = store.name || "TOKO SAYA",
    storeAddress = store.address || "",
    total = totalAmount || 0,
    payment = cashReceived || 0,
    change = cashChange || 0,
    cashier = "",
    transactionId = receiptNumber || orderNumber || ""
  } = receiptData;

  let receipt = commands.INIT;

  // Header
  receipt += commands.ALIGN_CENTER;
  receipt += commands.BOLD_ON;
  receipt += cleanText(store.name || storeName) + commands.NEW_LINE;
  receipt += commands.BOLD_OFF;

  const address = store.address || storeAddress;
  if (address) {
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
  receipt += "--------------------------------" + commands.NEW_LINE;

  // Items header
  receipt += formatLine("Item", "Qty  Harga") + commands.NEW_LINE;
  receipt += "--------------------------------" + commands.NEW_LINE;

  // Items
  items.forEach(item => {
    const name = cleanText(item.name || "").substring(0, 28);
    const qty = parseInt(item.quantity || item.qty || 0);
    const price = item.price || 0;
    const itemSubtotal = price * qty;

    receipt += name + commands.NEW_LINE;
    receipt += formatLine(`  ${qty} x ${formatRupiah(price)}`, formatRupiah(itemSubtotal)) + commands.NEW_LINE;

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

    if (item.notes) {
      const notes = cleanText(item.notes).substring(0, 28);
      receipt += `    Note: ${notes}` + commands.NEW_LINE;
    }

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

  if (additionalServiceValue > 0) {
    receipt += formatLine("Biaya Tambahan:", formatRupiah(additionalServiceValue)) + commands.NEW_LINE;
    if (additionalServiceNotes) {
      const notes = cleanText(additionalServiceNotes).substring(0, 28);
      receipt += `  (${notes})` + commands.NEW_LINE;
    }
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

function createQCLabelText(data) {
  const {
    orderId = "",
    orderNumber = "",
    customerName = "",
    customerPhone = "",
    items = [],
    qcStatus = "",
    qcNotes = "",
    qcBy = "",
    totalAmount = "",
    createdAt = ""
  } = data;

  let label = commands.INIT;

  // Header
  label += commands.ALIGN_CENTER;
  label += commands.BOLD_ON;
  label += commands.DOUBLE_HEIGHT;
  label += "LABEL QC" + commands.NEW_LINE;
  label += commands.NORMAL_SIZE;
  label += commands.BOLD_OFF;
  label += "================================" + commands.NEW_LINE;
  label += commands.ALIGN_LEFT;
  label += commands.NEW_LINE;

  // Order Info
  if (orderNumber) label += "No. Order: " + cleanText(orderNumber) + commands.NEW_LINE;

  // Format date
  const date = createdAt ? new Date(createdAt).toLocaleString('id-ID', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }) : "";
  if (date) label += "Tanggal: " + cleanText(date) + commands.NEW_LINE;

  label += "--------------------------------" + commands.NEW_LINE;

  // Customer Info
  if (customerName) label += "Customer: " + cleanText(customerName) + commands.NEW_LINE;
  if (customerPhone) label += "Telp: " + cleanText(customerPhone) + commands.NEW_LINE;

  if (customerName || customerPhone) {
    label += "--------------------------------" + commands.NEW_LINE;
  }

  // Items
  label += commands.BOLD_ON;
  label += "ITEMS:" + commands.NEW_LINE;
  label += commands.BOLD_OFF;

  items.forEach((item, index) => {
    const productName = cleanText(item.productName || "").substring(0, 30);
    const qty = parseInt(item.quantity || 0);

    label += `${index + 1}. ${productName}` + commands.NEW_LINE;
    label += `   Qty: ${qty}` + commands.NEW_LINE;

    // Finishings
    if (item.finishings && Array.isArray(item.finishings) && item.finishings.length > 0) {
      label += "   Finishing:" + commands.NEW_LINE;
      item.finishings.forEach(finishing => {
        const finishingName = cleanText(finishing.name || "").substring(0, 26);
        label += `   - ${finishingName}` + commands.NEW_LINE;
      });
    }

    label += commands.NEW_LINE;
  });

  label += "--------------------------------" + commands.NEW_LINE;

  // QC Status
  label += commands.BOLD_ON;
  label += commands.ALIGN_CENTER;

  if (qcStatus === "PASSED") {
    label += "STATUS: LULUS QC" + commands.NEW_LINE;
  } else if (qcStatus === "FAILED") {
    label += "STATUS: GAGAL QC" + commands.NEW_LINE;
  } else {
    label += "STATUS: " + cleanText(qcStatus) + commands.NEW_LINE;
  }

  label += commands.BOLD_OFF;
  label += commands.ALIGN_LEFT;
  label += commands.NEW_LINE;

  // QC Notes
  if (qcNotes) {
    label += "Catatan QC:" + commands.NEW_LINE;
    const notes = cleanText(qcNotes);
    const noteLines = notes.match(/.{1,30}(\s|$)/g) || [notes];
    noteLines.forEach(line => {
      label += cleanText(line.trim()) + commands.NEW_LINE;
    });
    label += commands.NEW_LINE;
  }

  // QC By
  if (qcBy) {
    label += "QC By: " + cleanText(qcBy) + commands.NEW_LINE;
  }

  label += commands.NEW_LINE;
  label += commands.ALIGN_CENTER;
  label += "-- END OF LABEL --" + commands.NEW_LINE;
  label += commands.NEW_LINE;
  label += commands.FEED_LINE;
  label += commands.FEED_LINE;
  label += commands.CUT;

  return label;
}

// ===========================================
// API ENDPOINTS
// ===========================================

// Get available printers (with rescan)
app.get('/printer/ports', async (req, res) => {
  try {
    const printers = await scanPrinters();
    availablePrinters = printers;

    res.json({
      success: true,
      ports: printers.map(p => ({
        path: p.name,
        manufacturer: p.driver,
        port: p.port
      })),
      currentPrinter: currentPrinter
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to scan printers',
      error: error.message
    });
  }
});

// Set active printer
app.post('/printer/connect', (req, res) => {
  const { port } = req.body;

  if (port) {
    currentPrinter = port;
  }

  res.json({
    success: true,
    message: `Printer set to ${currentPrinter}`,
    port: currentPrinter
  });
});

// Get printer status
app.get('/printer/status', (req, res) => {
  res.json({
    success: true,
    connected: true,
    port: currentPrinter,
    availablePrinters: availablePrinters,
    autoReconnectEnabled: autoReconnectEnabled,
    isMonitoring: reconnectInterval !== null
  });
});

// Rescan and auto-connect
app.post('/printer/rescan', async (req, res) => {
  try {
    const connected = await autoConnectPrinter();

    res.json({
      success: connected,
      message: connected ? `Connected to ${currentPrinter}` : 'No working printer found',
      currentPrinter: currentPrinter,
      availablePrinters: availablePrinters
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Rescan failed',
      error: error.message
    });
  }
});

// Enable/disable auto-reconnect monitoring
app.post('/printer/auto-reconnect', (req, res) => {
  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'enabled parameter must be a boolean'
      });
    }

    autoReconnectEnabled = enabled;

    if (enabled) {
      startReconnectMonitor();
    } else {
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
      message: 'Failed to change auto-reconnect setting',
      error: error.message
    });
  }
});

// Print test
app.post('/print/test', async (req, res) => {
  try {
    let testData = commands.INIT;
    testData += commands.ALIGN_CENTER;
    testData += commands.DOUBLE_HEIGHT;
    testData += commands.BOLD_ON;
    testData += "TEST PRINT" + commands.NEW_LINE;
    testData += commands.BOLD_OFF;
    testData += commands.NORMAL_SIZE;
    testData += commands.ALIGN_LEFT;
    testData += commands.NEW_LINE;
    testData += "Printer: " + currentPrinter + commands.NEW_LINE;
    testData += "Time: " + new Date().toLocaleString('id-ID') + commands.NEW_LINE;
    testData += commands.NEW_LINE;
    testData += commands.ALIGN_CENTER;
    testData += "Print berhasil!" + commands.NEW_LINE;
    testData += commands.NEW_LINE;
    testData += commands.FEED_LINE;
    testData += commands.CUT;

    await printToWindowsPrinter(currentPrinter, testData);

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

// Print receipt - GET method
app.get('/print/receipt', async (req, res) => {
  try {
    let receiptData = req.query;
    if (req.query.data) {
      try {
        receiptData = JSON.parse(decodeURIComponent(req.query.data));
      } catch (parseError) {
        console.error("Failed to parse JSON data:", parseError.message);
        throw new Error("Invalid JSON data in query parameter");
      }
    }

    const receiptText = createReceiptText(receiptData);
    await printToWindowsPrinter(currentPrinter, receiptText);

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
        </style>
      </head>
      <body>
        <div class="error">❌ Print gagal!</div>
        <div class="message">${error.message}</div>
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

// Print QC label - GET method
app.get('/print/qc', async (req, res) => {
  try {
    let qcData = req.query;
    if (req.query.data) {
      try {
        qcData = JSON.parse(decodeURIComponent(req.query.data));
      } catch (parseError) {
        console.error("Failed to parse JSON data:", parseError.message);
        throw new Error("Invalid JSON data in query parameter");
      }
    }

    const qcLabelText = createQCLabelText(qcData);
    await printToWindowsPrinter(currentPrinter, qcLabelText);

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
        <div class="success">✅ Print QC Label berhasil!</div>
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
        </style>
      </head>
      <body>
        <div class="error">❌ Print QC Label gagal!</div>
        <div class="message">${error.message}</div>
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

// Print text only
app.post('/print/text', async (req, res) => {
  try {
    const { text = "" } = req.body;

    let printData = commands.INIT;
    printData += text + commands.NEW_LINE;
    printData += commands.FEED_LINE;
    printData += commands.CUT;

    await printToWindowsPrinter(currentPrinter, printData);

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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Shutting down server...');
  stopReconnectMonitor();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🖨️  Windows Printer API Server running on port ${PORT}`);
  console.log("\n📋 Available endpoints:");
  console.log("GET  /printer/ports - Scan and list available printers");
  console.log("POST /printer/connect - Manually set active printer");
  console.log("POST /printer/rescan - Rescan and auto-connect to printer");
  console.log("GET  /printer/status - Check printer status");
  console.log("POST /printer/auto-reconnect - Enable/disable auto-reconnect");
  console.log("GET  /print/receipt - Print receipt");
  console.log("GET  /print/qc - Print QC label");
  console.log("POST /print/test - Test print");
  console.log("POST /print/text - Print simple text");
  console.log("\n✅ This version uses Windows Print Spooler with Win32 API");
  console.log("✅ Works with USB printers on CP ports");
  console.log("✅ No COM port required!");
  console.log("✅ Auto-scan and auto-connect on startup");
  console.log("✅ Auto-reconnect monitoring (30s interval)");

  // Auto-connect on startup
  setTimeout(async () => {
    const connected = await autoConnectPrinter();

    if (connected && autoReconnectEnabled) {
      console.log('\n🔄 Auto-reconnect monitoring enabled');
      startReconnectMonitor();
    } else if (!connected) {
      console.log('\n⚠️  No printer connected. Use POST /printer/rescan to try again.');
    }
  }, 1000);
});
