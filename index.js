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
const CONFIG_FILE = path.join(__dirname, 'printer_config.json');
let currentPrinter = DEFAULT_PRINTER;
let availablePrinters = [];
let autoReconnectEnabled = false; // Default disabled untuk hemat kertas
let reconnectInterval = null;
let lastPrintTime = 0; // Track waktu print terakhir
let isPrinting = false; // Lock untuk mencegah print bersamaan

// Load config dari file (dipanggil saat startup)
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.currentPrinter) {
        currentPrinter = cfg.currentPrinter;
        console.log(`📂 Config loaded: printer = "${currentPrinter}"`);
      }
      if (typeof cfg.autoReconnectEnabled === 'boolean') {
        autoReconnectEnabled = cfg.autoReconnectEnabled;
      }
    } else {
      console.log(`📂 No config file found, using default printer: "${DEFAULT_PRINTER}"`);
    }
  } catch (e) {
    console.error('⚠️  Failed to load config:', e.message);
  }
}

// Simpan config ke file
function saveConfig() {
  try {
    const cfg = {
      currentPrinter,
      autoReconnectEnabled,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`💾 Config saved: printer = "${currentPrinter}"`);
  } catch (e) {
    console.error('⚠️  Failed to save config:', e.message);
  }
}

// Load config saat modul pertama kali dijalankan
loadConfig();

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

  // Transaction info — selalu gunakan local datetime saat cetak
  const printDate = new Date().toLocaleString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  receipt += "Tanggal: " + cleanText(printDate) + commands.NEW_LINE;
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
    const stockType = (item.stockType || "").toUpperCase();
    const ukuran = item.ukuran || "";
    const dimensions = item.dimensions || null;
    // Untuk AREA/METERAN, gunakan item.total karena sudah dikalikan dengan area/panjang
    const itemTotal = item.total || (price * qty);

    receipt += name + commands.NEW_LINE;

    // Tampilkan ukuran jika stockType adalah AREA atau METERAN
    if (stockType === "AREA" && ukuran) {
      const area = dimensions ? dimensions.area : null;
      if (area) {
        receipt += `  ${cleanText(ukuran)} (${area}m2)` + commands.NEW_LINE;
        receipt += formatLine(`  ${formatRupiah(price)}/m2 x ${area}`, formatRupiah(itemTotal)) + commands.NEW_LINE;
      } else {
        receipt += `  Ukuran: ${cleanText(ukuran)}` + commands.NEW_LINE;
        receipt += formatLine(`  ${qty} x ${formatRupiah(price)}`, formatRupiah(itemTotal)) + commands.NEW_LINE;
      }
    } else if (stockType === "METERAN" && ukuran) {
      const length = item.meterLength || (dimensions ? dimensions.length : null);
      if (length) {
        receipt += `  Panjang: ${length}m` + commands.NEW_LINE;
        receipt += formatLine(`  ${formatRupiah(price)}/m x ${length}`, formatRupiah(itemTotal)) + commands.NEW_LINE;
      } else {
        receipt += `  Ukuran: ${cleanText(ukuran)}` + commands.NEW_LINE;
        receipt += formatLine(`  ${qty} x ${formatRupiah(price)}`, formatRupiah(itemTotal)) + commands.NEW_LINE;
      }
    } else {
      // Untuk produk non-AREA/METERAN, gunakan qty x price
      receipt += formatLine(`  ${qty} x ${formatRupiah(price)}`, formatRupiah(itemTotal)) + commands.NEW_LINE;
    }

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

    // Tampilkan total item jika ada finishing
    if (finishingTotal > 0) {
      const finalItemTotal = itemTotal + finishingTotal;
      receipt += formatLine("  Total item:", formatRupiah(finalItemTotal)) + commands.NEW_LINE;
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

// Printer Management UI
app.get('/printer/ui', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Printer Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --surface2: #21253a;
      --border: #2d3147;
      --accent: #6c63ff;
      --accent-hover: #5a52e8;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #e2e8f0;
      --text-muted: #8892a4;
      --radius: 12px;
      --radius-sm: 8px;
    }

    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 24px 16px;
    }

    .container { max-width: 720px; margin: 0 auto; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 28px;
    }
    .header-icon {
      width: 44px; height: 44px;
      background: linear-gradient(135deg, var(--accent), #a78bfa);
      border-radius: var(--radius-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px;
      flex-shrink: 0;
    }
    .header h1 { font-size: 20px; font-weight: 700; }
    .header p { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

    /* Status Bar */
    .status-bar {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .status-left { display: flex; align-items: center; gap: 12px; }
    .status-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: var(--text-muted);
      flex-shrink: 0;
      transition: background .3s;
    }
    .status-dot.connected { background: var(--success); box-shadow: 0 0 8px var(--success); }
    .status-dot.error { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
    .status-info strong { font-size: 14px; }
    .status-info span { font-size: 12px; color: var(--text-muted); display: block; margin-top: 1px; }
    .status-badges { display: flex; gap: 8px; flex-wrap: wrap; }
    .badge {
      font-size: 11px; font-weight: 600;
      padding: 3px 10px;
      border-radius: 20px;
      border: 1px solid var(--border);
      color: var(--text-muted);
    }
    .badge.on { border-color: var(--success); color: var(--success); background: rgba(34,197,94,.1); }
    .badge.busy { border-color: var(--warning); color: var(--warning); background: rgba(245,158,11,.1); }

    /* Section */
    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      margin-bottom: 16px;
    }
    .section-header {
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .section-header h2 { font-size: 14px; font-weight: 600; }
    .section-body { padding: 16px 20px; }

    /* Printer List */
    .printer-list { display: flex; flex-direction: column; gap: 10px; }
    .printer-card {
      background: var(--surface2);
      border: 2px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px 16px;
      display: flex;
      align-items: center;
      gap: 14px;
      cursor: pointer;
      transition: border-color .2s, background .2s;
    }
    .printer-card:hover { border-color: var(--accent); background: rgba(108,99,255,.07); }
    .printer-card.active {
      border-color: var(--accent);
      background: rgba(108,99,255,.12);
    }
    .printer-card.active .printer-radio { background: var(--accent); border-color: var(--accent); }
    .printer-card.active .printer-radio::after { opacity: 1; }
    .printer-radio {
      width: 18px; height: 18px;
      border-radius: 50%;
      border: 2px solid var(--border);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: all .2s;
      position: relative;
    }
    .printer-radio::after {
      content: '';
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #fff;
      opacity: 0;
      transition: opacity .2s;
    }
    .printer-icon { font-size: 24px; flex-shrink: 0; }
    .printer-details { flex: 1; min-width: 0; }
    .printer-name {
      font-size: 14px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .printer-meta {
      font-size: 12px; color: var(--text-muted);
      margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .printer-tag {
      font-size: 10px; font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .printer-tag.active { background: rgba(108,99,255,.2); color: #a78bfa; }
    .printer-tag.available { background: rgba(34,197,94,.15); color: var(--success); }

    /* Empty state */
    .empty {
      text-align: center;
      padding: 32px 16px;
      color: var(--text-muted);
    }
    .empty .empty-icon { font-size: 40px; margin-bottom: 10px; }
    .empty p { font-size: 13px; line-height: 1.6; }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 13px;
      font-weight: 600;
      padding: 9px 18px;
      border-radius: var(--radius-sm);
      border: none;
      cursor: pointer;
      transition: all .2s;
      font-family: inherit;
      white-space: nowrap;
    }
    .btn:disabled { opacity: .5; cursor: not-allowed; }
    .btn-primary {
      background: var(--accent);
      color: #fff;
    }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn-ghost {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid var(--border);
    }
    .btn-ghost:hover:not(:disabled) { color: var(--text); border-color: var(--text-muted); }
    .btn-danger {
      background: transparent;
      color: var(--danger);
      border: 1px solid rgba(239,68,68,.3);
    }
    .btn-danger:hover:not(:disabled) { background: rgba(239,68,68,.1); }
    .btn-success {
      background: transparent;
      color: var(--success);
      border: 1px solid rgba(34,197,94,.3);
    }
    .btn-success:hover:not(:disabled) { background: rgba(34,197,94,.1); }
    .btn-sm { padding: 6px 12px; font-size: 12px; }

    .btn-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }

    /* Actions panel */
    .actions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 10px;
    }
    .action-btn {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px 12px;
      text-align: center;
      cursor: pointer;
      transition: all .2s;
      font-family: inherit;
      color: var(--text);
    }
    .action-btn:hover:not(:disabled) { border-color: var(--accent); background: rgba(108,99,255,.08); }
    .action-btn:disabled { opacity: .4; cursor: not-allowed; }
    .action-btn .action-icon { font-size: 22px; margin-bottom: 6px; }
    .action-btn .action-label { font-size: 12px; font-weight: 600; }
    .action-btn .action-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

    /* Log */
    .log-box {
      background: #0d0f17;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 14px;
      font-family: 'Consolas', monospace;
      font-size: 12px;
      line-height: 1.7;
      max-height: 200px;
      overflow-y: auto;
      color: var(--text-muted);
    }
    .log-box .log-line { padding: 1px 0; }
    .log-box .ok { color: #4ade80; }
    .log-box .err { color: #f87171; }
    .log-box .info { color: #60a5fa; }
    .log-box .warn { color: #fbbf24; }

    /* Toast */
    #toast-container {
      position: fixed;
      bottom: 20px; right: 20px;
      display: flex; flex-direction: column; gap: 8px;
      z-index: 999;
    }
    .toast {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 18px;
      font-size: 13px;
      display: flex; align-items: center; gap: 10px;
      animation: slide-in .25s ease;
      min-width: 240px;
      max-width: 340px;
    }
    .toast.success { border-color: var(--success); }
    .toast.error { border-color: var(--danger); }
    @keyframes slide-in {
      from { transform: translateX(30px); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    /* Spinner */
    .spin {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid rgba(255,255,255,.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin .6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .divider { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  </style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <div class="header-icon">🖨️</div>
    <div>
      <h1>Printer Manager</h1>
      <p>Kelola koneksi dan pengaturan printer thermal</p>
    </div>
  </div>

  <!-- Status Bar -->
  <div class="status-bar">
    <div class="status-left">
      <div class="status-dot" id="statusDot"></div>
      <div class="status-info">
        <strong id="statusPrinter">Memuat...</strong>
        <span id="statusSub">Mengambil status printer...</span>
      </div>
    </div>
    <div class="status-badges">
      <span class="badge" id="badgeJobs">0 jobs</span>
      <span class="badge" id="badgePrinting">Idle</span>
      <span class="badge" id="badgeMonitor">Monitor: off</span>
    </div>
  </div>

  <!-- Printer Selection -->
  <div class="section">
    <div class="section-header">
      <h2>🖨️ Pilih Printer Aktif</h2>
      <div class="btn-row">
        <button class="btn btn-ghost btn-sm" onclick="rescanPrinters()" id="btnRescan">
          🔍 Scan Ulang
        </button>
      </div>
    </div>
    <div class="section-body">
      <div class="printer-list" id="printerList">
        <div class="empty">
          <div class="empty-icon">🔍</div>
          <p>Memuat daftar printer...</p>
        </div>
      </div>
      <hr class="divider">
      <div class="btn-row">
        <button class="btn btn-primary" onclick="setActivePrinter()" id="btnSet" disabled>
          ✅ Terapkan Pilihan
        </button>
      </div>
    </div>
  </div>

  <!-- Quick Actions -->
  <div class="section">
    <div class="section-header">
      <h2>⚡ Aksi Cepat</h2>
    </div>
    <div class="section-body">
      <div class="actions-grid">
        <button class="action-btn" onclick="testPrint()">
          <div class="action-icon">🧾</div>
          <div class="action-label">Test Print</div>
          <div class="action-desc">Cetak halaman uji</div>
        </button>
        <button class="action-btn" onclick="clearJobs()">
          <div class="action-icon">🧹</div>
          <div class="action-label">Clear Jobs</div>
          <div class="action-desc">Hapus antrian print</div>
        </button>
        <button class="action-btn" onclick="resetPrinter()">
          <div class="action-icon">🔄</div>
          <div class="action-label">Reset</div>
          <div class="action-desc">Reset &amp; init printer</div>
        </button>
        <button class="action-btn" onclick="toggleMonitor()" id="btnMonitor">
          <div class="action-icon">📡</div>
          <div class="action-label">Auto Monitor</div>
          <div class="action-desc" id="monitorDesc">Aktifkan monitoring</div>
        </button>
      </div>
    </div>
  </div>

  <!-- Log -->
  <div class="section">
    <div class="section-header">
      <h2>📋 Log Aktivitas</h2>
      <button class="btn btn-ghost btn-sm" onclick="clearLog()">Bersihkan</button>
    </div>
    <div class="section-body" style="padding-top:0">
      <div class="log-box" id="logBox">
        <div class="log-line info">🚀 Printer Manager siap.</div>
      </div>
    </div>
  </div>

</div>

<div id="toast-container"></div>

<script>
  const BASE = window.location.origin;
  let selectedPrinter = null;
  let currentActivePrinter = null;
  let monitorEnabled = false;

  // ── Logging ──────────────────────────────────────────
  function addLog(msg, type = 'info') {
    const box = document.getElementById('logBox');
    const line = document.createElement('div');
    line.className = 'log-line ' + type;
    const time = new Date().toLocaleTimeString('id-ID');
    line.textContent = '[' + time + '] ' + msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    document.getElementById('logBox').innerHTML = '';
    addLog('Log dibersihkan.', 'info');
  }

  // ── Toast ─────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
    const el = document.createElement('div');
    el.className = 'toast ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
    el.innerHTML = '<span>' + (icons[type] || 'ℹ️') + '</span><span>' + msg + '</span>';
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── Status ────────────────────────────────────────────
  async function refreshStatus() {
    try {
      const r = await fetch(BASE + '/printer/status');
      const d = await r.json();
      currentActivePrinter = d.port;
      monitorEnabled = d.autoReconnectEnabled;

      // Dot
      const dot = document.getElementById('statusDot');
      dot.className = 'status-dot ' + (d.connected ? 'connected' : 'error');

      document.getElementById('statusPrinter').textContent = d.port || 'Tidak ada printer';
      document.getElementById('statusSub').textContent = d.connected ? 'Printer aktif' : 'Tidak terhubung';

      // Badges
      document.getElementById('badgeJobs').textContent = (d.pendingJobs || 0) + ' jobs';
      const badgePrint = document.getElementById('badgePrinting');
      if (d.isPrinting) {
        badgePrint.textContent = 'Mencetak...';
        badgePrint.className = 'badge busy';
      } else {
        badgePrint.textContent = 'Idle';
        badgePrint.className = 'badge';
      }
      const badgeMon = document.getElementById('badgeMonitor');
      if (d.isMonitoring) {
        badgeMon.textContent = 'Monitor: on';
        badgeMon.className = 'badge on';
      } else {
        badgeMon.textContent = 'Monitor: off';
        badgeMon.className = 'badge';
      }

      // Monitor button desc
      document.getElementById('monitorDesc').textContent = monitorEnabled ? 'Nonaktifkan' : 'Aktifkan monitoring';

      // Update available printers if returned
      if (d.availablePrinters && d.availablePrinters.length > 0) {
        renderPrinterList(d.availablePrinters, d.port);
      }
    } catch (e) {
      document.getElementById('statusPrinter').textContent = 'Error';
      document.getElementById('statusSub').textContent = 'Tidak bisa terhubung ke server';
      document.getElementById('statusDot').className = 'status-dot error';
    }
  }

  // ── Printer List ──────────────────────────────────────
  function renderPrinterList(printers, active) {
    const list = document.getElementById('printerList');

    if (!printers || printers.length === 0) {
      list.innerHTML = '<div class="empty"><div class="empty-icon">🔌</div><p>Tidak ada printer ditemukan.<br>Pastikan printer terhubung lalu klik <strong>Scan Ulang</strong>.</p></div>';
      document.getElementById('btnSet').disabled = true;
      return;
    }

    list.innerHTML = printers.map(p => {
      const isActive = (p.name || p.path) === active;
      const printerName = p.name || p.path || 'Unknown';
      const meta = [p.port, p.driver].filter(Boolean).join(' · ') || 'Windows Printer';
      return \`<div class="printer-card \${isActive ? 'active' : ''}" onclick="selectPrinter('\${escHtml(printerName)}', this)" data-name="\${escHtml(printerName)}">
        <div class="printer-radio"></div>
        <div class="printer-icon">🖨️</div>
        <div class="printer-details">
          <div class="printer-name">\${escHtml(printerName)}</div>
          <div class="printer-meta">\${escHtml(meta)}</div>
        </div>
        \${isActive ? '<span class="printer-tag active">AKTIF</span>' : '<span class="printer-tag available">Tersedia</span>'}
      </div>\`;
    }).join('');

    // Pre-select the active printer
    if (active) {
      selectedPrinter = active;
      document.getElementById('btnSet').disabled = false;
    }
  }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function selectPrinter(name, el) {
    selectedPrinter = name;
    document.querySelectorAll('.printer-card').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    document.getElementById('btnSet').disabled = false;
    addLog('Dipilih: ' + name, 'info');
  }

  // ── Actions ───────────────────────────────────────────
  async function rescanPrinters() {
    const btn = document.getElementById('btnRescan');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Scanning...';
    addLog('Memulai scan printer...', 'info');

    try {
      const r = await fetch(BASE + '/printer/rescan', { method: 'POST' });
      const d = await r.json();
      addLog(d.message, d.success ? 'ok' : 'warn');
      if (d.availablePrinters) renderPrinterList(d.availablePrinters, d.currentPrinter);
      if (d.success) toast('Printer ditemukan: ' + d.currentPrinter, 'success');
      else toast('Tidak ada printer ditemukan', 'warn');
      await refreshStatus();
    } catch (e) {
      addLog('Scan gagal: ' + e.message, 'err');
      toast('Scan gagal', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '🔍 Scan Ulang';
    }
  }

  async function setActivePrinter() {
    if (!selectedPrinter) return;
    const btn = document.getElementById('btnSet');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Menerapkan...';
    addLog('Mengatur printer aktif: ' + selectedPrinter, 'info');

    try {
      const r = await fetch(BASE + '/printer/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: selectedPrinter })
      });
      const d = await r.json();
      addLog(d.message, d.success ? 'ok' : 'err');
      if (d.success) {
        toast('Printer aktif: ' + selectedPrinter, 'success');
        await refreshStatus();
      } else {
        toast('Gagal mengatur printer', 'error');
      }
    } catch (e) {
      addLog('Error: ' + e.message, 'err');
      toast('Koneksi gagal', 'error');
    } finally {
      btn.innerHTML = '✅ Terapkan Pilihan';
      btn.disabled = false;
    }
  }

  async function testPrint() {
    addLog('Mengirim test print ke ' + (currentActivePrinter || '?'), 'info');
    try {
      const r = await fetch(BASE + '/print/test', { method: 'POST' });
      const d = await r.json();
      addLog(d.message, d.success ? 'ok' : 'err');
      toast(d.success ? 'Test print berhasil!' : 'Test print gagal: ' + d.message, d.success ? 'success' : 'error');
    } catch (e) {
      addLog('Error: ' + e.message, 'err');
      toast('Gagal terhubung ke server', 'error');
    }
  }

  async function clearJobs() {
    addLog('Membersihkan antrian print...', 'info');
    try {
      const r = await fetch(BASE + '/printer/clear-jobs', { method: 'POST' });
      const d = await r.json();
      addLog(d.message, d.success ? 'ok' : 'err');
      toast(d.success ? 'Antrian dibersihkan' : 'Gagal: ' + d.message, d.success ? 'success' : 'error');
      await refreshStatus();
    } catch (e) {
      addLog('Error: ' + e.message, 'err');
    }
  }

  async function resetPrinter() {
    addLog('Reset printer: ' + (currentActivePrinter || '?'), 'warn');
    try {
      const r = await fetch(BASE + '/printer/reset', { method: 'POST' });
      const d = await r.json();
      addLog(d.message, d.success ? 'ok' : 'err');
      toast(d.success ? 'Printer berhasil di-reset' : 'Reset gagal', d.success ? 'success' : 'error');
    } catch (e) {
      addLog('Error: ' + e.message, 'err');
    }
  }

  async function toggleMonitor() {
    const newState = !monitorEnabled;
    addLog((newState ? 'Mengaktifkan' : 'Menonaktifkan') + ' auto-monitor...', 'info');
    try {
      const r = await fetch(BASE + '/printer/auto-reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newState })
      });
      const d = await r.json();
      addLog(d.message, d.success ? 'ok' : 'err');
      toast(d.message, d.success ? 'success' : 'error');
      await refreshStatus();
    } catch (e) {
      addLog('Error: ' + e.message, 'err');
    }
  }

  // ── Init ──────────────────────────────────────────────
  async function init() {
    await refreshStatus();
    // Also do a fresh scan to populate list
    try {
      const r = await fetch(BASE + '/printer/ports');
      const d = await r.json();
      if (d.ports && d.ports.length > 0) {
        renderPrinterList(d.ports.map(p => ({ name: p.path, port: p.port, driver: p.manufacturer })), d.currentPrinter);
      }
    } catch (e) {
      addLog('Gagal memuat daftar printer awal', 'err');
    }
  }

  init();
  // Auto-refresh status every 10s
  setInterval(refreshStatus, 10000);
</script>
</body>
</html>`);
});

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
    saveConfig(); // Simpan pilihan printer ke file
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

    saveConfig(); // Simpan setting auto-reconnect ke file

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
    if (currentPrinter !== DEFAULT_PRINTER) {
      // Ada printer tersimpan di config, verifikasi dulu apakah masih tersedia
      console.log(`\n🔗 Using saved printer: "${currentPrinter}"`);
      const isWorking = await testPrinter(currentPrinter);
      if (isWorking) {
        console.log(`✅ Saved printer "${currentPrinter}" is available`);
        // Tetap scan untuk update daftar availablePrinters
        availablePrinters = await scanPrinters();
      } else {
        console.log(`⚠️  Saved printer "${currentPrinter}" not found, scanning for alternatives...`);
        const connected = await autoConnectPrinter();
        if (connected) saveConfig(); // Simpan printer baru yang berhasil connect
      }
    } else {
      // Tidak ada config, lakukan auto-detect seperti biasa
      const connected = await autoConnectPrinter();
      if (connected) saveConfig();
    }

    if (autoReconnectEnabled) {
      console.log('\n🔄 Auto-reconnect monitoring enabled');
      startReconnectMonitor();
    } else {
      console.log('\n⚠️  No printer connected. Use POST /printer/rescan to try again.');
    }
  }, 1000);
});