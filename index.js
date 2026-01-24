// Windows Printer API untuk POS58
// Menggunakan PowerShell untuk print langsung ke Windows printer

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());

// Disable caching untuk semua print endpoints
app.use('/print', (req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  next();
});

// Configuration
const DEFAULT_PRINTER = 'POS58'; // Nama printer Windows Anda
const DEBUG_MODE = process.env.DEBUG === 'true' || true; // Set false di production
const PRINT_COOLDOWN_MS = 500; // Minimum delay between prints (0.5 detik)
let currentPrinter = DEFAULT_PRINTER;
let availablePrinters = [];
let autoReconnectEnabled = false; // Default disabled untuk hemat kertas
let reconnectInterval = null;
let lastPrintTime = 0; // Track waktu print terakhir
let isPrinting = false; // Lock untuk mencegah print bersamaan

// Debug logger
function debugLog(...args) {
  if (DEBUG_MODE) console.log(...args);
}

// Escape HTML untuk keamanan
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

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

// Function untuk clear print jobs yang stuck
function clearPrintJobs(printerName) {
  return new Promise((resolve) => {
    exec(`powershell "Get-PrintJob -PrinterName '${printerName}' -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue"`, {
      timeout: 5000
    }, (error, stdout, stderr) => {
      if (error) {
        debugLog('Clear jobs note:', error.message);
      }
      resolve(); // Always resolve, don't fail if clearing jobs fails
    });
  });
}

// Function untuk print ke Windows printer menggunakan raw data via Win32 API
function printToWindowsPrinter(printerName, data, retryCount = 0) {
  const maxRetries = 2; // Additional retries at Node level

  return new Promise(async (resolve, reject) => {
    // Check if another print is in progress
    if (isPrinting) {
      console.log('⏳ Another print in progress, waiting...');
      // Wait for current print to finish
      let waitCount = 0;
      while (isPrinting && waitCount < 30) { // Max 30 seconds wait
        await new Promise(r => setTimeout(r, 1000));
        waitCount++;
      }
      if (isPrinting) {
        reject(new Error('Print timeout: previous print still in progress'));
        return;
      }
    }

    // Enforce cooldown between prints
    const now = Date.now();
    const timeSinceLastPrint = now - lastPrintTime;
    if (timeSinceLastPrint < PRINT_COOLDOWN_MS && lastPrintTime > 0) {
      const waitTime = PRINT_COOLDOWN_MS - timeSinceLastPrint;
      console.log(`⏳ Cooldown: waiting ${waitTime}ms before next print...`);
      await new Promise(r => setTimeout(r, waitTime));
    }

    // Set printing lock
    isPrinting = true;

    try {
      // Clear any stuck jobs before printing
      await clearPrintJobs(printerName);

      // Create temp file dengan raw data
      const tempFile = path.join(os.tmpdir(), `print_${Date.now()}.bin`);

      try {
        // Write binary data to file
        fs.writeFileSync(tempFile, data, 'binary');
      } catch (err) {
        isPrinting = false;
        reject(new Error(`Failed to create temp file: ${err.message}`));
        return;
      }

      // Use the raw_print.ps1 script
      const rawPrintScript = path.join(__dirname, 'raw_print.ps1');

      debugLog(`Sending print job to ${printerName}...`);

      // Execute PowerShell raw printing with retries built-in
      exec(`powershell -ExecutionPolicy Bypass -File "${rawPrintScript}" -PrinterName "${printerName}" -DataFile "${tempFile}" -MaxRetries 2`, {
        timeout: 15000 // Faster timeout
      }, async (error, stdout, stderr) => {
        // Cleanup temp file
        try {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        } catch (e) {
          debugLog('Cleanup warning:', e.message);
        }

        const output = stdout + stderr;
        debugLog('Print output:', output);

        if (output.includes('Print successful')) {
          console.log('✅ Print completed successfully');
          lastPrintTime = Date.now();
          isPrinting = false;
          resolve('Print successful');
        } else if (error || !output.includes('Print successful')) {
          console.error('❌ Print failed:', output);

          // Retry at Node level if PowerShell retries also failed
          if (retryCount < maxRetries) {
            console.log(`🔄 Retrying at Node level (${retryCount + 1}/${maxRetries})...`);
            isPrinting = false; // Release lock for retry
            await clearPrintJobs(printerName);
            await new Promise(r => setTimeout(r, 500)); // Brief wait before retry

            try {
              const result = await printToWindowsPrinter(printerName, data, retryCount + 1);
              resolve(result);
            } catch (retryError) {
              reject(retryError);
            }
          } else {
            isPrinting = false;
            reject(new Error(`Print failed after all retries. Output: ${output.substring(0, 200)}`));
          }
        }
      });
    } catch (err) {
      isPrinting = false;
      reject(err);
    }
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
    designCost = 0,
    designerName = "",
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
    cashierName = "",
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
  if (cashierName || cashier) receipt += "Kasir: " + cleanText(cashierName || cashier) + commands.NEW_LINE;
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

  if (designCost > 0) {
    receipt += formatLine("Biaya Desain:", formatRupiah(designCost)) + commands.NEW_LINE;
    if (designerName) {
      receipt += `  (Designer: ${cleanText(designerName)})` + commands.NEW_LINE;
    }
  } else if (additionalServiceValue > 0) {
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
app.get('/printer/status', async (req, res) => {
  // Check for pending print jobs
  let pendingJobs = 0;
  try {
    const result = await new Promise((resolve) => {
      exec(`powershell "(Get-PrintJob -PrinterName '${currentPrinter}' -ErrorAction SilentlyContinue | Measure-Object).Count"`, {
        timeout: 3000
      }, (error, stdout) => {
        resolve(error ? 0 : parseInt(stdout.trim()) || 0);
      });
    });
    pendingJobs = result;
  } catch (e) {
    pendingJobs = 0;
  }

  res.json({
    success: true,
    connected: true,
    port: currentPrinter,
    availablePrinters: availablePrinters,
    autoReconnectEnabled: autoReconnectEnabled,
    isMonitoring: reconnectInterval !== null,
    isPrinting: isPrinting,
    pendingJobs: pendingJobs,
    lastPrintTime: lastPrintTime > 0 ? new Date(lastPrintTime).toISOString() : null
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

// Clear stuck print jobs
app.post('/printer/clear-jobs', async (req, res) => {
  try {
    console.log('🧹 Clearing print jobs for:', currentPrinter);
    await clearPrintJobs(currentPrinter);

    res.json({
      success: true,
      message: `Print jobs cleared for ${currentPrinter}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to clear print jobs',
      error: error.message
    });
  }
});

// Reset printer (clear jobs + send init command)
app.post('/printer/reset', async (req, res) => {
  try {
    console.log('🔄 Resetting printer:', currentPrinter);

    // Clear stuck jobs
    await clearPrintJobs(currentPrinter);

    // Send ESC/POS init command to reset printer
    const initCommand = commands.INIT + commands.FEED_LINE;
    await printToWindowsPrinter(currentPrinter, initCommand);

    res.json({
      success: true,
      message: `Printer ${currentPrinter} has been reset`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to reset printer',
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
  const requestId = Date.now(); // Untuk tracking request

  try {
    debugLog(`\n📄 [${requestId}] ========== RECEIPT REQUEST ==========`);
    debugLog(`[${requestId}] Data param exists:`, !!req.query.data);
    debugLog(`[${requestId}] Data length:`, req.query.data?.length || 0);

    // Parse receipt data
    let receiptData;

    if (!req.query.data) {
      throw new Error("Parameter 'data' tidak ditemukan di URL");
    }

    try {
      const decodedData = decodeURIComponent(req.query.data);
      receiptData = JSON.parse(decodedData);
    } catch (parseError) {
      console.error(`[${requestId}] ❌ JSON parse error:`, parseError.message);
      throw new Error("Format JSON tidak valid. Pastikan data di-encode dengan benar.");
    }

    // Extract dan validasi
    const dataToCheck = receiptData.receiptData || receiptData;
    const items = dataToCheck.items || [];
    const totalAmount = dataToCheck.totalAmount || dataToCheck.total || 0;

    debugLog(`[${requestId}] Items: ${items.length}, Total: ${totalAmount}`);

    // Validasi data tidak kosong
    if (items.length === 0 && totalAmount === 0) {
      console.error(`[${requestId}] ⚠️ Empty data! Keys:`, Object.keys(dataToCheck));
      throw new Error("Data receipt kosong. Pastikan items dan total terisi.");
    }

    // Print
    const receiptText = createReceiptText(receiptData);
    await printToWindowsPrinter(currentPrinter, receiptText);

    debugLog(`[${requestId}] ✅ Print success`);

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
    console.error("Print error:", error.message);
    const safeMessage = escapeHtml(error.message);

    res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Print Error</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
          .error { color: #f44336; font-size: 20px; margin-bottom: 15px; }
          .message { color: #666; font-size: 14px; margin-bottom: 15px; }
          .retry { margin-top: 20px; }
          .retry button { padding: 10px 20px; font-size: 14px; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="error">❌ Print gagal!</div>
        <div class="message">${safeMessage}</div>
        <div class="retry">
          <button onclick="location.reload()">Coba Lagi</button>
        </div>
        <script>
          setTimeout(() => {
            if (window.opener) {
              window.opener.focus();
              window.close();
            } else {
              window.close();
            }
          }, 5000);
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

// Print receipt - POST method (more reliable for large data)
app.post('/print/receipt', async (req, res) => {
  try {
    const receiptData = req.body;

    // Debug logging
    console.log('\n📄 POST Receipt request received:');
    console.log('Content-Type:', req.headers['content-type']);

    // Extract items for validation
    const dataToCheck = receiptData.receiptData || receiptData;
    const items = dataToCheck.items || [];

    console.log('Items count:', items.length);
    console.log('Total amount:', dataToCheck.totalAmount || dataToCheck.total || 0);

    // Validate
    if (items.length === 0 && !dataToCheck.totalAmount && !dataToCheck.total) {
      console.error('⚠️  WARNING: Empty receipt data detected!');
      console.error('Full received data:', JSON.stringify(receiptData));
      return res.status(400).json({
        success: false,
        message: "Data receipt kosong. Pastikan data dikirim dengan benar."
      });
    }

    const receiptText = createReceiptText(receiptData);
    await printToWindowsPrinter(currentPrinter, receiptText);

    res.json({
      success: true,
      message: "Receipt printed successfully",
      itemsCount: items.length
    });
  } catch (error) {
    console.error("Print error:", error);
    res.status(500).json({
      success: false,
      message: "Receipt print failed",
      error: error.message
    });
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
  console.log("POST /printer/clear-jobs - Clear stuck print jobs");
  console.log("POST /printer/reset - Reset printer (clear jobs + init)");
  console.log("POST /printer/auto-reconnect - Enable/disable auto-reconnect");
  console.log("GET  /print/receipt - Print receipt (via URL query)");
  console.log("POST /print/receipt - Print receipt (via JSON body)");
  console.log("GET  /print/qc - Print QC label");
  console.log("POST /print/test - Test print");
  console.log("POST /print/text - Print simple text");
  console.log("\n✅ Windows Print Spooler with Win32 API");
  console.log("✅ Works with USB printers on CP ports");
  console.log("✅ Auto-retry on print failure (3 attempts)");
  console.log("✅ Auto-clear stuck print jobs");
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
