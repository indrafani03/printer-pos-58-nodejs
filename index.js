// Windows Printer API untuk POS58
// Menggunakan PowerShell untuk print langsung ke Windows printer

const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const https = require('https');
const axios = require('axios');
const sharp = require('sharp');

// Paksa Node resolve IPv4 dulu — fix ENOTFOUND di jaringan customer yang IPv6-nya
// nge-return AAAA tapi gak routable (Node v17+ default verbatim, gak ada Happy Eyeballs).
dns.setDefaultResultOrder('ipv4first');

// Agent yang force family: 4 sebagai sabuk pengaman ekstra untuk download logo CDN.
const ipv4HttpsAgent = new https.Agent({ family: 4, keepAlive: true });

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
let currentLanguage = 'id';  // default Indonesian
let currentCurrency = 'IDR'; // default Rupiah
let currentPaperWidth = 32;  // 32 untuk 58mm, 48 untuk 80mm
let customText = {};          // override teks struk/label, e.g. { "receipt.thankYou": "Makasih!" }

// Load config dari file (dipanggil saat startup)
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const cfg = JSON.parse(raw);
      if (cfg.currentPrinter) {
        currentPrinter = cfg.currentPrinter;
      }
      if (typeof cfg.autoReconnectEnabled === 'boolean') {
        autoReconnectEnabled = cfg.autoReconnectEnabled;
      }
      if (cfg.language) {
        currentLanguage = cfg.language;
      }
      if (cfg.currency) {
        currentCurrency = cfg.currency;
      }
      if (cfg.paperWidth && [32, 48].includes(cfg.paperWidth)) {
        currentPaperWidth = cfg.paperWidth;
      }
      if (cfg.customText && typeof cfg.customText === 'object') {
        customText = cfg.customText;
      }
      console.log(`📂 Config loaded: printer="${currentPrinter}", lang="${currentLanguage}", currency="${currentCurrency}", paperWidth=${currentPaperWidth}`);
    } else {
      console.log(`📂 No config file found, using defaults: printer="${DEFAULT_PRINTER}", lang="${currentLanguage}", currency="${currentCurrency}"`);
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
      language: currentLanguage,
      currency: currentCurrency,
      paperWidth: currentPaperWidth,
      customText,
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    console.log(`💾 Config saved: printer="${currentPrinter}", lang="${currentLanguage}", currency="${currentCurrency}", paperWidth=${currentPaperWidth}`);
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

// Resolve teks dengan prioritas: customText > translations[lang]
function resolveText(key, lang) {
  if (customText[key] !== undefined && customText[key] !== '') return customText[key];
  const parts = key.split('.');
  let value = translations[lang];
  for (const k of parts) value = value?.[k];
  return value || key;
}

// Escape HTML untuk keamanan
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// Download dan konversi logo ke ESC/POS raster image bytes
// paperWidthPx: 384 untuk 58mm paper (POS58 @203dpi)
async function getLogoEscPos(logoUrl, paperWidthPx = 384) {
  try {
    console.log('🖼️ Downloading logo:', logoUrl);

    // Retry sampai 3x — sering kasus ENOTFOUND first-call sembuh di attempt ke-2
    // setelah DNS cache OS warm up.
    let response;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await axios.get(logoUrl, {
          responseType: 'arraybuffer',
          timeout: 8000,
          httpsAgent: ipv4HttpsAgent,
          headers: { 'User-Agent': 'PrinterService/1.0' }
        });
        break;
      } catch (e) {
        lastErr = e;
        const retryable = ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET'].includes(e.code);
        if (!retryable || attempt === 3) throw e;
        console.warn(`⚠️ Logo fetch attempt ${attempt} failed (${e.code}), retrying...`);
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    const imageBuffer = Buffer.from(response.data);

    // Ukuran logo: 200px lebar (~52% lebar kertas 58mm)
    const targetWidth = 200;

    // Proses dengan sharp
    const { data: pixels, info } = await sharp(imageBuffer)
      .resize(targetWidth, null, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .normalise()
      .sharpen({ sigma: 1.5, m1: 1.5, m2: 2 })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    console.log(`🖼️ Logo processed: ${width}x${height}px`);

    // Total bytes per row berdasarkan lebar kertas (384px / 8 = 48 bytes)
    const totalBytesPerRow = Math.ceil(paperWidthPx / 8);

    // Offset kiri untuk centering logo
    const leftPaddingPx = Math.floor((paperWidthPx - width) / 2);

    // --- Floyd-Steinberg Dithering ---
    // Menghasilkan gradasi yang lebih smooth di printer thermal 1-bit
    // Salin pixels ke Float32Array agar bisa menyimpan error diffusion
    const gray = new Float32Array(width * height);
    for (let i = 0; i < pixels.length; i++) gray[i] = pixels[i];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const oldVal = Math.max(0, Math.min(255, gray[idx]));
        const newVal = oldVal < 128 ? 0 : 255; // threshold
        gray[idx] = newVal;
        const err = oldVal - newVal;

        // Sebarkan error ke tetangga (Floyd-Steinberg weights)
        if (x + 1 < width) gray[idx + 1] += err * 7 / 16;
        if (y + 1 < height && x > 0) gray[idx + width - 1] += err * 3 / 16;
        if (y + 1 < height) gray[idx + width] += err * 5 / 16;
        if (y + 1 < height && x + 1 < width) gray[idx + width + 1] += err * 1 / 16;
      }
    }

    // Konversi hasil dithering ke 1-bit monochrome (format ESC/POS: MSB first)
    const bitmapRows = [];
    for (let y = 0; y < height; y++) {
      const row = new Uint8Array(totalBytesPerRow);
      for (let x = 0; x < width; x++) {
        const bitX = x + leftPaddingPx;
        if (bitX < paperWidthPx && gray[y * width + x] === 0) { // pixel hitam = cetak
          row[Math.floor(bitX / 8)] |= (0x80 >> (bitX % 8));
        }
      }
      bitmapRows.push(...row);
    }

    // ESC/POS: GS v 0 (raster bit image)
    // \x1d\x76\x30 mode xL xH yL yH [data...]
    const xL = totalBytesPerRow & 0xFF;
    const xH = (totalBytesPerRow >> 8) & 0xFF;
    const yL = height & 0xFF;
    const yH = (height >> 8) & 0xFF;

    const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    const bitmapBuffer = Buffer.from(new Uint8Array(bitmapRows));
    const marginBottom = Buffer.from('\n\n', 'binary'); // 2 baris margin bawah logo

    console.log(`✅ Logo ESC/POS ready: ${header.length + bitmapBuffer.length} bytes`);
    return Buffer.concat([header, bitmapBuffer, marginBottom]);

  } catch (err) {
    console.error('❌ Logo failed (lanjut tanpa logo):', err.message);
    return null;
  }
}

// Gabungkan logo bytes + receipt text menjadi satu Buffer untuk dikirim ke printer
// Logo disisipkan setelah INIT + ALIGN_CENTER (5 bytes pertama receipt)
async function buildReceiptBuffer(receiptText, store, paperWidth = currentPaperWidth) {
  const receiptBuffer = Buffer.from(receiptText, 'binary');

  if (store?.hasLogo && store?.logoUrl) {
    // 58mm paper = 384px, 80mm paper = 576px (both @203dpi)
    const paperWidthPx = paperWidth >= 48 ? 576 : 384;
    const logoBytes = await getLogoEscPos(store.logoUrl, paperWidthPx);
    if (logoBytes) {
      // INIT = \x1B\x40 (2 bytes), ALIGN_CENTER = \x1B\x61\x01 (3 bytes)
      const insertPos = 5;
      return Buffer.concat([
        receiptBuffer.slice(0, insertPos),  // INIT + ALIGN_CENTER
        logoBytes,                           // gambar logo + margin sudah ada di dalamnya
        receiptBuffer.slice(insertPos)       // sisa struk
      ]);
    }
  }

  return receiptBuffer;
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

// Translation System
const translations = {
  id: {
    receipt: {
      date: "Tanggal",
      receiptNo: "No. Struk",
      orderNo: "No. Order",
      cashier: "Kasir",
      customer: "Customer",
      item: "Item",
      qty: "Qty",
      price: "Harga",
      subtotal: "Subtotal",
      discount: "Diskon",
      ppn: "PPN",
      designCost: "Biaya Desain",
      additionalCost: "Biaya Tambahan",
      total: "TOTAL",
      paymentMethod: "Metode",
      paid: "Bayar",
      change: "Kembali",
      thankYou: "Terima Kasih!",
      comeAgain: "Selamat Berbelanja Kembali",
      totalItem: "Total item",
      per: "per",
      length: "Panjang",
      size: "Ukuran",
      note: "Note",
      finishing: "Finishing",
      paymentType: "Jenis Bayar",
      downpayment: "DP",
      hutang: "Hutang",
      lunas: "Lunas",
      remaining: "Sisa Bayar"
    },
    qc: {
      title: "LABEL QC",
      orderNo: "No. Order",
      date: "Tanggal",
      customer: "Customer",
      phone: "Telp",
      items: "ITEMS",
      qty: "Qty",
      size: "Ukuran",
      length: "Panjang",
      finishing: "Finishing",
      status: "STATUS",
      passed: "LULUS QC",
      failed: "GAGAL QC",
      notes: "Catatan QC",
      qcBy: "QC By",
      payment: "STATUS BAYAR",
      paid: "LUNAS",
      unpaid: "BELUM BAYAR",
      partial: "DP",
      endLabel: "-- END OF LABEL --"
    },
    ui: {
      title: "Printer Manager",
      subtitle: "Kelola koneksi dan pengaturan printer thermal",
      loading: "Memuat...",
      fetchingStatus: "Mengambil status printer...",
      noPrinter: "Tidak ada printer",
      printerActive: "Printer aktif",
      notConnected: "Tidak terhubung",
      jobs: "jobs",
      printing: "Mencetak...",
      idle: "Idle",
      monitorOn: "Monitor: on",
      monitorOff: "Monitor: off",
      selectPrinter: "Pilih Printer Aktif",
      scanAgain: "Scan Ulang",
      loadingPrinters: "Memuat daftar printer...",
      noPrintersFound: "Tidak ada printer ditemukan",
      ensurePrinterConnected: "Pastikan printer terhubung lalu klik",
      applySelection: "Terapkan Pilihan",
      quickActions: "Aksi Cepat",
      testPrint: "Test Print",
      testPrintDesc: "Cetak halaman uji",
      clearJobs: "Clear Jobs",
      clearJobsDesc: "Hapus antrian print",
      reset: "Reset",
      resetDesc: "Reset & init printer",
      autoMonitor: "Auto Monitor",
      enableMonitoring: "Aktifkan monitoring",
      disableMonitoring: "Nonaktifkan",
      activityLog: "Log Aktivitas",
      clear: "Bersihkan",
      ready: "Printer Manager siap",
      active: "AKTIF",
      available: "Tersedia",
      settings: "Pengaturan",
      language: "Bahasa",
      currency: "Mata Uang",
      saveSettings: "Simpan Pengaturan"
    },
    messages: {
      printSuccess: "Print berhasil!",
      printFailed: "Print gagal!",
      closingIn: "Menutup dalam",
      seconds: "detik",
      retry: "Coba Lagi",
      scanningPrinters: "Memulai scan printer...",
      printersFound: "Printer ditemukan",
      noPrintersDetected: "Tidak ada printer ditemukan",
      settingPrinter: "Mengatur printer aktif",
      printerSetSuccess: "Printer aktif",
      printerSetFailed: "Gagal mengatur printer",
      connectionFailed: "Koneksi gagal",
      sendingTestPrint: "Mengirim test print ke",
      testPrintSuccess: "Test print berhasil!",
      clearingJobs: "Membersihkan antrian print...",
      jobsCleared: "Antrian dibersihkan",
      resettingPrinter: "Reset printer",
      printerResetSuccess: "Printer berhasil di-reset",
      resetFailed: "Reset gagal",
      enablingMonitor: "Mengaktifkan",
      disablingMonitor: "Menonaktifkan",
      autoMonitorText: "auto-monitor...",
      logCleared: "Log dibersihkan",
      cannotConnectServer: "Tidak bisa terhubung ke server",
      settingsSaved: "Pengaturan disimpan",
      settingsSaveFailed: "Gagal menyimpan pengaturan"
    }
  },
  en: {
    receipt: {
      date: "Date",
      receiptNo: "Receipt No",
      orderNo: "Order No",
      cashier: "Cashier",
      customer: "Customer",
      item: "Item",
      qty: "Qty",
      price: "Price",
      subtotal: "Subtotal",
      discount: "Discount",
      ppn: "Tax",
      designCost: "Design Fee",
      additionalCost: "Additional Fee",
      total: "TOTAL",
      paymentMethod: "Method",
      paid: "Paid",
      change: "Change",
      thankYou: "Thank You!",
      comeAgain: "Come Again Soon",
      totalItem: "Item total",
      per: "per",
      length: "Length",
      size: "Size",
      note: "Note",
      finishing: "Finishing",
      paymentType: "Payment Type",
      downpayment: "Down Payment",
      hutang: "Credit",
      lunas: "Paid Off",
      remaining: "Remaining"
    },
    qc: {
      title: "QC LABEL",
      orderNo: "Order No",
      date: "Date",
      customer: "Customer",
      phone: "Phone",
      items: "ITEMS",
      qty: "Qty",
      size: "Size",
      length: "Length",
      finishing: "Finishing",
      status: "STATUS",
      passed: "QC PASSED",
      failed: "QC FAILED",
      notes: "QC Notes",
      qcBy: "QC By",
      payment: "PAYMENT STATUS",
      paid: "PAID",
      unpaid: "UNPAID",
      partial: "PARTIAL",
      endLabel: "-- END OF LABEL --"
    },
    ui: {
      title: "Printer Manager",
      subtitle: "Manage thermal printer connection and settings",
      loading: "Loading...",
      fetchingStatus: "Fetching printer status...",
      noPrinter: "No printer",
      printerActive: "Printer active",
      notConnected: "Not connected",
      jobs: "jobs",
      printing: "Printing...",
      idle: "Idle",
      monitorOn: "Monitor: on",
      monitorOff: "Monitor: off",
      selectPrinter: "Select Active Printer",
      scanAgain: "Scan Again",
      loadingPrinters: "Loading printer list...",
      noPrintersFound: "No printers found",
      ensurePrinterConnected: "Ensure printer is connected then click",
      applySelection: "Apply Selection",
      quickActions: "Quick Actions",
      testPrint: "Test Print",
      testPrintDesc: "Print test page",
      clearJobs: "Clear Jobs",
      clearJobsDesc: "Clear print queue",
      reset: "Reset",
      resetDesc: "Reset & init printer",
      autoMonitor: "Auto Monitor",
      enableMonitoring: "Enable monitoring",
      disableMonitoring: "Disable",
      activityLog: "Activity Log",
      clear: "Clear",
      ready: "Printer Manager ready",
      active: "ACTIVE",
      available: "Available",
      settings: "Settings",
      language: "Language",
      currency: "Currency",
      saveSettings: "Save Settings"
    },
    messages: {
      printSuccess: "Print successful!",
      printFailed: "Print failed!",
      closingIn: "Closing in",
      seconds: "seconds",
      retry: "Retry",
      scanningPrinters: "Scanning printers...",
      printersFound: "Printers found",
      noPrintersDetected: "No printers detected",
      settingPrinter: "Setting active printer",
      printerSetSuccess: "Active printer",
      printerSetFailed: "Failed to set printer",
      connectionFailed: "Connection failed",
      sendingTestPrint: "Sending test print to",
      testPrintSuccess: "Test print successful!",
      clearingJobs: "Clearing print queue...",
      jobsCleared: "Queue cleared",
      resettingPrinter: "Resetting printer",
      printerResetSuccess: "Printer successfully reset",
      resetFailed: "Reset failed",
      enablingMonitor: "Enabling",
      disablingMonitor: "Disabling",
      autoMonitorText: "auto-monitor...",
      logCleared: "Log cleared",
      cannotConnectServer: "Cannot connect to server",
      settingsSaved: "Settings saved",
      settingsSaveFailed: "Failed to save settings"
    }
  }
};

// Currency Configuration
const currencyConfig = {
  IDR: {
    locale: 'id-ID',
    currency: 'IDR',
    symbol: 'Rp',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  },
  USD: {
    locale: 'en-US',
    currency: 'USD',
    symbol: '$',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }
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

// Format currency based on current or specified currency
function formatCurrency(amount, currency = currentCurrency) {
  const config = currencyConfig[currency];
  if (!config) {
    // Fallback to IDR if currency not found
    currency = 'IDR';
    config = currencyConfig.IDR;
  }

  const formatted = new Intl.NumberFormat(config.locale, {
    style: 'currency',
    currency: config.currency,
    minimumFractionDigits: config.minimumFractionDigits,
    maximumFractionDigits: config.maximumFractionDigits
  }).format(amount);

  // For IDR, replace "IDR" with "Rp"
  const cleaned = currency === 'IDR'
    ? formatted.replace('IDR', config.symbol)
    : formatted;

  return cleanText(cleaned);
}

// Format date/time based on language locale
function formatDateTime(date = new Date(), lang = currentLanguage) {
  const locale = lang === 'id' ? 'id-ID' : 'en-US';

  return new Date(date).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function createReceiptText(data, lang = currentLanguage, currency = currentCurrency, paperWidth = currentPaperWidth) {
  // Translation helper — customText overrides first
  const t = (key) => resolveText(key, lang);

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
    orderTotalAmount = 0,
    paymentMethod = "",
    paymentType = "",
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

  const SEP_EQUAL = '='.repeat(paperWidth);
  const SEP_DASH  = '-'.repeat(paperWidth);
  const addrWrap  = paperWidth - 2;

  let receipt = commands.INIT;

  // Header
  receipt += commands.ALIGN_CENTER;
  receipt += commands.BOLD_ON;
  receipt += cleanText(store.name || storeName) + commands.NEW_LINE;
  receipt += commands.BOLD_OFF;

  const address = store.address || storeAddress;
  if (address) {
    const cleanAddress = cleanText(address);
    const addrRegex = new RegExp(`.{1,${addrWrap}}(\\s|$)`, 'g');
    const addressLines = cleanAddress.match(addrRegex) || [cleanAddress];
    addressLines.forEach(line => {
      receipt += cleanText(line.trim()) + commands.NEW_LINE;
    });
  }

  if (store.phone) {
    receipt += "Tel: " + cleanText(store.phone) + commands.NEW_LINE;
  }

  receipt += SEP_EQUAL + commands.NEW_LINE;
  receipt += commands.ALIGN_LEFT;
  receipt += commands.NEW_LINE;

  // Transaction info — selalu gunakan local datetime saat cetak
  const printDate = formatDateTime(new Date(), lang);
  receipt += t('receipt.date') + ": " + cleanText(printDate) + commands.NEW_LINE;
  if (receiptNumber) receipt += t('receipt.receiptNo') + ": " + cleanText(receiptNumber) + commands.NEW_LINE;
  if (orderNumber) receipt += t('receipt.orderNo') + ": " + cleanText(orderNumber) + commands.NEW_LINE;
  if (cashierName || cashier) receipt += t('receipt.cashier') + ": " + cleanText(cashierName || cashier) + commands.NEW_LINE;
  if (customerName) receipt += t('receipt.customer') + ": " + cleanText(customerName) + commands.NEW_LINE;
  receipt += SEP_DASH + commands.NEW_LINE;

  // Items header
  receipt += formatLine(t('receipt.item'), t('receipt.qty') + "  " + t('receipt.price'), paperWidth) + commands.NEW_LINE;
  receipt += SEP_DASH + commands.NEW_LINE;

  // Items
  items.forEach(item => {
    // Decode URL-encoded name and replace + with spaces for variants
    let decodedName = item.name || "";
    try {
      decodedName = decodeURIComponent(decodedName.replace(/\+/g, ' '));
    } catch (e) {
      decodedName = decodedName.replace(/\+/g, ' ');
    }
    const name = cleanText(decodedName); // No length limit for full variant display
    const qty = parseInt(item.quantity || item.qty || 0);
    const price = item.price || 0;
    const stockType = (item.stockType || "").toUpperCase();
    const ukuran = item.ukuran || "";
    const dimensions = item.dimensions || null;
    // Gunakan productTotal (harga produk saja, tanpa finishing) agar finishing tidak terhitung 2x
    // Fallback ke item.total jika productTotal tidak ada (backward compatibility)
    const itemTotal = item.productTotal != null ? item.productTotal : (item.total || (price * qty));

    receipt += name + commands.NEW_LINE;

    // Tampilkan ukuran jika stockType adalah AREA atau METERAN
    if (stockType === "AREA" && ukuran) {
      const area = dimensions ? dimensions.area : null;
      if (area) {
        const left = qty > 1
          ? `  ${qty} x ${cleanText(ukuran)} x ${formatCurrency(price, currency)}`
          : `  ${cleanText(ukuran)} x ${formatCurrency(price, currency)}`;
        receipt += formatLine(left, formatCurrency(itemTotal, currency), paperWidth) + commands.NEW_LINE;
      } else {
        receipt += `  ${t('receipt.size')}: ${cleanText(ukuran)}` + commands.NEW_LINE;
        receipt += formatLine(`  ${qty} x ${formatCurrency(price, currency)}`, formatCurrency(itemTotal, currency), paperWidth) + commands.NEW_LINE;
      }
    } else if (stockType === "METERAN" && ukuran) {
      const length = item.meterLength || (dimensions ? dimensions.length : null);
      if (length) {
        const left = qty > 1
          ? `  ${qty} x ${cleanText(ukuran)} x ${formatCurrency(price, currency)}`
          : `  ${cleanText(ukuran)} x ${formatCurrency(price, currency)}`;
        receipt += formatLine(left, formatCurrency(itemTotal, currency), paperWidth) + commands.NEW_LINE;
      } else {
        receipt += `  ${t('receipt.size')}: ${cleanText(ukuran)}` + commands.NEW_LINE;
        receipt += formatLine(`  ${qty} x ${formatCurrency(price, currency)}`, formatCurrency(itemTotal, currency), paperWidth) + commands.NEW_LINE;
      }
    } else {
      // Untuk produk non-AREA/METERAN, gunakan qty x price
      receipt += formatLine(`  ${qty} x ${formatCurrency(price, currency)}`, formatCurrency(itemTotal, currency), paperWidth) + commands.NEW_LINE;
    }

    let finishingTotal = 0;
    if (item.finishings && Array.isArray(item.finishings) && item.finishings.length > 0) {
      item.finishings.forEach(finishing => {
        const finishingName = cleanText(finishing.name || "").substring(0, paperWidth - 12);
        const finishingQty = finishing.finishingQty || finishing.quantity || 1;
        const finishingPrice = finishing.price || 0;
        const finishingItemTotal = finishingPrice * (finishing.multiplyByQty ? qty : 1) * finishingQty;
        finishingTotal += finishingItemTotal;
        receipt += formatLine(`    + ${finishingName} (${finishingQty}x)`, formatCurrency(finishingItemTotal, currency), paperWidth) + commands.NEW_LINE;
      });
    }

    if (item.notes) {
      const notes = cleanText(item.notes).substring(0, paperWidth - 4);
      receipt += `    ${t('receipt.note')}: ${notes}` + commands.NEW_LINE;
    }

    // Tampilkan total item jika ada finishing
    if (finishingTotal > 0) {
      const finalItemTotal = itemTotal + finishingTotal;
      receipt += formatLine("  " + t('receipt.totalItem') + ":", formatCurrency(finalItemTotal, currency), paperWidth) + commands.NEW_LINE;
    }
  });

  receipt += SEP_DASH + commands.NEW_LINE;

  // Totals
  if (subtotal > 0 && subtotal !== totalAmount) {
    receipt += formatLine(t('receipt.subtotal') + ":", formatCurrency(subtotal, currency), paperWidth) + commands.NEW_LINE;
  }

  if (ppnAmount > 0) {
    receipt += formatLine(t('receipt.ppn') + ":", formatCurrency(ppnAmount, currency), paperWidth) + commands.NEW_LINE;
  }

  if (discountAmount > 0) {
    receipt += formatLine(t('receipt.discount') + ":", "-" + formatCurrency(discountAmount, currency), paperWidth) + commands.NEW_LINE;
  }

  if (designCost > 0) {
    receipt += formatLine(t('receipt.designCost') + ":", formatCurrency(designCost, currency), paperWidth) + commands.NEW_LINE;
    if (designerName) {
      receipt += `  (Designer: ${cleanText(designerName)})` + commands.NEW_LINE;
    }
  } else if (additionalServiceValue > 0) {
    receipt += formatLine(t('receipt.additionalCost') + ":", formatCurrency(additionalServiceValue, currency), paperWidth) + commands.NEW_LINE;
    if (additionalServiceNotes) {
      const notes = cleanText(additionalServiceNotes).substring(0, paperWidth - 4);
      receipt += `  (${notes})` + commands.NEW_LINE;
    }
  }

  // Sembunyikan baris TOTAL ketika jenis pembayaran DP (DOWNPAYMENT)
  const isDP = paymentType && (paymentType.toUpperCase() === 'DOWNPAYMENT' || paymentType.toUpperCase() === 'DP');
  if (!isDP) {
    receipt += commands.BOLD_ON;
    receipt += formatLine(t('receipt.total') + ":", formatCurrency(totalAmount || total, currency), paperWidth) + commands.NEW_LINE;
    receipt += commands.BOLD_OFF;
  }

  if (paymentMethod) {
    receipt += formatLine(t('receipt.paymentMethod') + ":", cleanText(paymentMethod), paperWidth) + commands.NEW_LINE;
  }

  // Tampilkan jenis pembayaran
  if (paymentType) {
    const typeUpper = paymentType.toUpperCase();
    let typeLabel = cleanText(paymentType);
    if (typeUpper === 'DOWNPAYMENT') typeLabel = t('receipt.downpayment');
    else if (typeUpper === 'HUTANG') typeLabel = t('receipt.hutang');
    else if (typeUpper === 'LUNAS') typeLabel = t('receipt.lunas');
    receipt += formatLine(t('receipt.paymentType') + ":", typeLabel, paperWidth) + commands.NEW_LINE;
  }

  if ((cashReceived || payment) > 0) {
    receipt += formatLine(t('receipt.paid') + ":", formatCurrency(cashReceived || payment, currency), paperWidth) + commands.NEW_LINE;
  }

  // Tampilkan sisa bayar untuk DOWNPAYMENT atau HUTANG
  if (paymentType && (paymentType.toUpperCase() === 'DOWNPAYMENT' || paymentType.toUpperCase() === 'HUTANG')) {
    const orderTotal = orderTotalAmount || totalAmount || total;
    const paid = cashReceived || payment || 0;
    const remaining = orderTotal - paid;
    if (remaining > 0) {
      receipt += commands.BOLD_ON;
      receipt += formatLine(t('receipt.remaining') + ":", formatCurrency(remaining, currency), paperWidth) + commands.NEW_LINE;
      receipt += commands.BOLD_OFF;
    }
  }

  if ((cashChange || change) > 0) {
    receipt += formatLine(t('receipt.change') + ":", formatCurrency(cashChange || change, currency)) + commands.NEW_LINE;
  }

  receipt += commands.NEW_LINE;
  receipt += commands.ALIGN_CENTER;
  receipt += t('receipt.thankYou') + commands.NEW_LINE;
  receipt += t('receipt.comeAgain') + commands.NEW_LINE;
  receipt += commands.NEW_LINE;
  receipt += commands.FEED_LINE;
  receipt += commands.FEED_LINE;
  receipt += commands.FEED_LINE;
  receipt += commands.FEED_LINE;
  receipt += commands.CUT;

  return receipt;
}

function createQCLabelText(data, lang = currentLanguage, currency = currentCurrency, paperWidth = currentPaperWidth) {
  // Translation helper — customText overrides first
  const t = (key) => resolveText(key, lang);

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
    paidStatus = "",
    createdAt = ""
  } = data;

  const SEP_EQUAL = '='.repeat(paperWidth);
  const SEP_DASH  = '-'.repeat(paperWidth);

  let label = commands.INIT;

  // Header
  label += commands.ALIGN_CENTER;
  label += commands.BOLD_ON;
  label += commands.DOUBLE_HEIGHT;
  label += t('qc.title') + commands.NEW_LINE;
  label += commands.NORMAL_SIZE;
  label += commands.BOLD_OFF;
  label += SEP_EQUAL + commands.NEW_LINE;
  label += commands.ALIGN_LEFT;
  label += commands.NEW_LINE;

  // Order Info
  if (orderNumber) label += t('qc.orderNo') + ": " + cleanText(orderNumber) + commands.NEW_LINE;

  // Format date
  const date = createdAt ? formatDateTime(createdAt, lang) : "";
  if (date) label += t('qc.date') + ": " + cleanText(date) + commands.NEW_LINE;

  label += SEP_DASH + commands.NEW_LINE;

  // Customer Info
  if (customerName) label += t('qc.customer') + ": " + cleanText(customerName) + commands.NEW_LINE;
  if (customerPhone) label += t('qc.phone') + ": " + cleanText(customerPhone) + commands.NEW_LINE;

  if (customerName || customerPhone) {
    label += SEP_DASH + commands.NEW_LINE;
  }

  // Items
  label += commands.BOLD_ON;
  label += t('qc.items') + ":" + commands.NEW_LINE;
  label += commands.BOLD_OFF;

  items.forEach((item, index) => {
    const productName = cleanText(item.productName || "");
    const qty = parseInt(item.quantity || 0);
    const stockType = (item.stockType || "").toUpperCase();
    const ukuran = item.ukuran || "";
    const dimensions = item.dimensions || null;

    label += `${index + 1}. ${productName}` + commands.NEW_LINE;
    label += `   ${t('qc.qty')}: ${qty}` + commands.NEW_LINE;

    // Tampilkan ukuran untuk produk METERAN
    if (stockType === "METERAN") {
      const length = item.meterLength || (dimensions ? dimensions.length : null);
      const unit = item.meterUnit || "m";
      if (length) {
        label += `   ${t('qc.length')}: ${length}${unit}` + commands.NEW_LINE;
      } else if (ukuran) {
        label += `   ${t('qc.size')}: ${cleanText(ukuran)}` + commands.NEW_LINE;
      }
    } else if (stockType === "AREA" || stockType === "M2") {
      // Tampilkan ukuran untuk produk AREA / m2
      if (ukuran) {
        label += `   ${t('qc.size')}: ${cleanText(ukuran)}` + commands.NEW_LINE;
      } else if (dimensions && dimensions.length && dimensions.width) {
        const unit = dimensions.unit || "cm";
        label += `   ${t('qc.size')}: ${dimensions.length}x${dimensions.width}${unit}` + commands.NEW_LINE;
      }
    }

    // Finishings
    if (item.finishings && Array.isArray(item.finishings) && item.finishings.length > 0) {
      label += "   " + t('qc.finishing') + ":" + commands.NEW_LINE;
      item.finishings.forEach(finishing => {
        const finishingName = cleanText(finishing.name || "").substring(0, paperWidth - 5);
        label += `   - ${finishingName}` + commands.NEW_LINE;
      });
    }

    label += commands.NEW_LINE;
  });

  label += SEP_DASH + commands.NEW_LINE;

  // QC Status
  label += commands.BOLD_ON;
  label += commands.ALIGN_CENTER;

  if (qcStatus === "PASSED") {
    label += t('qc.status') + ": " + t('qc.passed') + commands.NEW_LINE;
  } else if (qcStatus === "FAILED") {
    label += t('qc.status') + ": " + t('qc.failed') + commands.NEW_LINE;
  } else {
    label += t('qc.status') + ": " + cleanText(qcStatus) + commands.NEW_LINE;
  }

  label += commands.BOLD_OFF;
  label += commands.ALIGN_LEFT;
  label += commands.NEW_LINE;

  // QC Notes
  if (qcNotes) {
    label += t('qc.notes') + ":" + commands.NEW_LINE;
    const notes = cleanText(qcNotes);
    const noteRegex = new RegExp(`.{1,${paperWidth - 2}}(\\s|$)`, 'g');
    const noteLines = notes.match(noteRegex) || [notes];
    noteLines.forEach(line => {
      label += cleanText(line.trim()) + commands.NEW_LINE;
    });
    label += commands.NEW_LINE;
  }

  // QC By
  if (qcBy) {
    label += t('qc.qcBy') + ": " + cleanText(qcBy) + commands.NEW_LINE;
  }

  // Payment Status
  if (paidStatus) {
    const paidUpper = String(paidStatus).toUpperCase();
    let paidLabel;
    if (paidUpper === "PAID" || paidUpper === "LUNAS") {
      paidLabel = t('qc.paid');
    } else if (paidUpper === "UNPAID" || paidUpper === "BELUM BAYAR" || paidUpper === "BELUM_BAYAR") {
      paidLabel = t('qc.unpaid');
    } else if (paidUpper === "PARTIAL" || paidUpper === "DP" || paidUpper === "DOWNPAYMENT") {
      paidLabel = t('qc.partial');
    } else {
      paidLabel = cleanText(paidStatus);
    }

    label += commands.NEW_LINE;
    label += SEP_DASH + commands.NEW_LINE;
    label += commands.BOLD_ON;
    label += commands.ALIGN_CENTER;
    label += t('qc.payment') + ": " + paidLabel + commands.NEW_LINE;
    label += commands.ALIGN_LEFT;
    label += commands.BOLD_OFF;
  }

  label += commands.NEW_LINE;
  label += commands.ALIGN_CENTER;
  label += t('qc.endLabel') + commands.NEW_LINE;
  label += commands.NEW_LINE;
  label += commands.FEED_LINE;
  label += commands.FEED_LINE;
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

    /* Select/Dropdown */
    .setting-select {
      width: 100%;
      padding: 10px 14px;
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color .2s;
    }
    .setting-select:hover {
      border-color: var(--accent);
    }
    .setting-select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(108,99,255,.15);
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

  <!-- Settings -->
  <div class="section">
    <div class="section-header">
      <h2 id="settingsTitle">⚙️ Pengaturan</h2>
    </div>
    <div class="section-body">
      <div style="display: grid; gap: 16px;">
        <!-- Language -->
        <div>
          <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px;" id="labelLanguage">Bahasa:</label>
          <select id="selectLanguage" class="setting-select" onchange="onLanguageChange()">
            <option value="id">Bahasa Indonesia</option>
            <option value="en">English</option>
          </select>
        </div>

        <!-- Currency -->
        <div>
          <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px;" id="labelCurrency">Mata Uang:</label>
          <select id="selectCurrency" class="setting-select" onchange="onCurrencyChange()">
            <option value="IDR">IDR (Rupiah)</option>
            <option value="USD">USD (US Dollar)</option>
          </select>
        </div>

        <!-- Paper Width -->
        <div>
          <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px;" id="labelPaperWidth">Ukuran Kertas:</label>
          <select id="selectPaperWidth" class="setting-select" onchange="onPaperWidthChange()">
            <option value="32">58mm (32 karakter)</option>
            <option value="48">80mm (48 karakter)</option>
          </select>
        </div>

        <button class="btn btn-primary" onclick="saveSettings()" id="btnSaveSettings">
          💾 Simpan Pengaturan
        </button>
      </div>
    </div>
  </div>

  <!-- Custom Text -->
  <div class="section">
    <div class="section-header" onclick="toggleCustomText()" style="cursor:pointer;user-select:none;">
      <h2 id="customTextTitle">✏️ Custom Teks Struk</h2>
      <span id="customTextToggle" style="font-size:12px;opacity:0.6;">▼ Tampilkan</span>
    </div>
    <div id="customTextBody" class="section-body" style="display:none;">
      <p style="font-size:12px;opacity:0.6;margin-bottom:12px;" id="customTextDesc">Kosongkan field untuk menggunakan teks default. Perubahan berlaku langsung saat disimpan.</p>
      <div id="customTextFields" style="display:grid;gap:10px;"></div>
      <button class="btn btn-primary" style="margin-top:14px;" onclick="saveCustomText()" id="btnSaveCustomText">💾 Simpan Custom Teks</button>
    </div>
  </div>

  <!-- Log -->
  <div class="section">
    <div class="section-header">
      <h2 id="logTitle">📋 Log Aktivitas</h2>
      <button class="btn btn-ghost btn-sm" onclick="clearLog()" id="btnClearLog">Bersihkan</button>
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
  let currentLanguage = 'id';
  let currentCurrency = 'IDR';
  let currentPaperWidth = 32;

  // Client-side translations (UI only)
  const translations = {
    id: {
      settings: "Pengaturan",
      language: "Bahasa",
      currency: "Mata Uang",
      paperWidth: "Ukuran Kertas",
      saveSettings: "Simpan Pengaturan",
      logTitle: "Log Aktivitas",
      clear: "Bersihkan",
      quickActions: "Aksi Cepat",
      testPrint: "Test Print",
      testPrintDesc: "Cetak halaman uji",
      clearJobs: "Clear Jobs",
      clearJobsDesc: "Hapus antrian print",
      reset: "Reset",
      resetDesc: "Reset & init printer",
      autoMonitor: "Auto Monitor",
      enableMonitoring: "Aktifkan monitoring",
      disableMonitoring: "Nonaktifkan",
      selectPrinter: "Pilih Printer Aktif",
      scanAgain: "Scan Ulang",
      applySelection: "Terapkan Pilihan",
      noPrinter: "Tidak ada printer",
      printerActive: "Printer aktif",
      notConnected: "Tidak terhubung",
      jobs: "jobs",
      printing: "Mencetak...",
      idle: "Idle",
      monitorOn: "Monitor: on",
      monitorOff: "Monitor: off",
      settingsSaved: "Pengaturan disimpan",
      settingsSaveFailed: "Gagal menyimpan pengaturan",
      loading: "Memuat...",
      ready: "Printer Manager siap"
    },
    en: {
      settings: "Settings",
      language: "Language",
      currency: "Currency",
      paperWidth: "Paper Size",
      saveSettings: "Save Settings",
      logTitle: "Activity Log",
      clear: "Clear",
      quickActions: "Quick Actions",
      testPrint: "Test Print",
      testPrintDesc: "Print test page",
      clearJobs: "Clear Jobs",
      clearJobsDesc: "Clear print queue",
      reset: "Reset",
      resetDesc: "Reset & init printer",
      autoMonitor: "Auto Monitor",
      enableMonitoring: "Enable monitoring",
      disableMonitoring: "Disable",
      selectPrinter: "Select Active Printer",
      scanAgain: "Scan Again",
      applySelection: "Apply Selection",
      noPrinter: "No printer",
      printerActive: "Printer active",
      notConnected: "Not connected",
      jobs: "jobs",
      printing: "Printing...",
      idle: "Idle",
      monitorOn: "Monitor: on",
      monitorOff: "Monitor: off",
      settingsSaved: "Settings saved",
      settingsSaveFailed: "Failed to save settings",
      loading: "Loading...",
      ready: "Printer Manager ready"
    }
  };

  // Translation helper
  function t(key) {
    return translations[currentLanguage][key] || key;
  }

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

  // ── Settings ──────────────────────────────────────────
  function updateUILanguage() {
    document.getElementById('settingsTitle').innerHTML = '⚙️ ' + t('settings');
    document.getElementById('labelLanguage').textContent = t('language') + ':';
    document.getElementById('labelCurrency').textContent = t('currency') + ':';
    document.getElementById('labelPaperWidth').textContent = t('paperWidth') + ':';
    document.getElementById('btnSaveSettings').innerHTML = '💾 ' + t('saveSettings');
    document.getElementById('logTitle').innerHTML = '📋 ' + t('logTitle');
    document.getElementById('btnClearLog').textContent = t('clear');

    // Quick Actions
    const actionsHeader = document.querySelector('.section:nth-child(3) .section-header h2');
    if (actionsHeader) actionsHeader.innerHTML = '⚡ ' + t('quickActions');

    // Update action button texts
    const actionLabels = document.querySelectorAll('.action-label');
    const actionDescs = document.querySelectorAll('.action-desc');
    if (actionLabels[0]) actionLabels[0].textContent = t('testPrint');
    if (actionDescs[0]) actionDescs[0].textContent = t('testPrintDesc');
    if (actionLabels[1]) actionLabels[1].textContent = t('clearJobs');
    if (actionDescs[1]) actionDescs[1].textContent = t('clearJobsDesc');
    if (actionLabels[2]) actionLabels[2].textContent = t('reset');
    if (actionDescs[2]) actionDescs[2].textContent = t('resetDesc');
    if (actionLabels[3]) actionLabels[3].textContent = t('autoMonitor');

    // Update select printer section
    const selectHeader = document.querySelector('.section:nth-child(2) .section-header h2');
    if (selectHeader) selectHeader.innerHTML = '🖨️ ' + t('selectPrinter');

    // Update buttons
    const btnRescan = document.getElementById('btnRescan');
    const btnSet = document.getElementById('btnSet');
    if (btnRescan) btnRescan.innerHTML = '🔍 ' + t('scanAgain');
    if (btnSet) btnSet.innerHTML = '✅ ' + t('applySelection');

    // Update status text
    if (document.getElementById('statusPrinter').textContent === 'Tidak ada printer' ||
        document.getElementById('statusPrinter').textContent === 'No printer') {
      document.getElementById('statusPrinter').textContent = t('noPrinter');
    }

    // Update log initial message
    const initialLog = document.querySelector('.log-line.info');
    if (initialLog && (initialLog.textContent.includes('siap') || initialLog.textContent.includes('ready'))) {
      initialLog.textContent = '🚀 ' + t('ready');
    }
  }

  function onLanguageChange() {
    currentLanguage = document.getElementById('selectLanguage').value;
    updateUILanguage();
  }

  function onCurrencyChange() {
    currentCurrency = document.getElementById('selectCurrency').value;
  }

  function onPaperWidthChange() {
    currentPaperWidth = parseInt(document.getElementById('selectPaperWidth').value);
  }

  async function saveSettings() {
    const btn = document.getElementById('btnSaveSettings');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> ' + t('loading');

    try {
      const r = await fetch(BASE + '/settings/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: currentLanguage,
          currency: currentCurrency,
          paperWidth: currentPaperWidth
        })
      });
      const d = await r.json();

      if (d.success) {
        toast(t('settingsSaved'), 'success');
        addLog(t('settingsSaved'), 'ok');
      } else {
        toast(t('settingsSaveFailed'), 'error');
        addLog(t('settingsSaveFailed'), 'err');
      }
    } catch (e) {
      toast(t('settingsSaveFailed'), 'error');
      addLog('Error: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '💾 ' + t('saveSettings');
    }
  }

  async function loadSettings() {
    try {
      const r = await fetch(BASE + '/settings/get');
      const d = await r.json();
      if (d.success) {
        if (d.language) {
          currentLanguage = d.language;
          document.getElementById('selectLanguage').value = currentLanguage;
        }
        if (d.currency) {
          currentCurrency = d.currency;
          document.getElementById('selectCurrency').value = currentCurrency;
        }
        if (d.paperWidth) {
          currentPaperWidth = d.paperWidth;
          document.getElementById('selectPaperWidth').value = String(currentPaperWidth);
        }
        updateUILanguage();
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  // ── Custom Text ───────────────────────────────────────
  // Definisi field yang bisa di-override (key: label tampilan)
  const CUSTOM_TEXT_FIELDS = [
    { group: '— Struk / Receipt —', fields: [
      { key: 'receipt.date',          label: 'Label Tanggal' },
      { key: 'receipt.receiptNo',     label: 'Label No. Struk' },
      { key: 'receipt.orderNo',       label: 'Label No. Order' },
      { key: 'receipt.cashier',       label: 'Label Kasir' },
      { key: 'receipt.customer',      label: 'Label Customer' },
      { key: 'receipt.item',          label: 'Header kolom Item' },
      { key: 'receipt.qty',           label: 'Header kolom Qty' },
      { key: 'receipt.price',         label: 'Header kolom Harga' },
      { key: 'receipt.subtotal',      label: 'Label Subtotal' },
      { key: 'receipt.discount',      label: 'Label Diskon' },
      { key: 'receipt.ppn',           label: 'Label PPN/Pajak' },
      { key: 'receipt.designCost',    label: 'Label Biaya Desain' },
      { key: 'receipt.additionalCost',label: 'Label Biaya Tambahan' },
      { key: 'receipt.total',         label: 'Label TOTAL' },
      { key: 'receipt.paymentMethod', label: 'Label Metode Bayar' },
      { key: 'receipt.paymentType',   label: 'Label Jenis Bayar' },
      { key: 'receipt.downpayment',   label: 'Teks DP' },
      { key: 'receipt.hutang',        label: 'Teks Hutang' },
      { key: 'receipt.lunas',         label: 'Teks Lunas' },
      { key: 'receipt.paid',          label: 'Label Bayar' },
      { key: 'receipt.change',        label: 'Label Kembalian' },
      { key: 'receipt.remaining',     label: 'Label Sisa Bayar' },
      { key: 'receipt.thankYou',      label: 'Pesan Terima Kasih' },
      { key: 'receipt.comeAgain',     label: 'Pesan Sampai Jumpa' },
    ]},
    { group: '— Label QC —', fields: [
      { key: 'qc.title',    label: 'Judul Label QC' },
      { key: 'qc.orderNo',  label: 'Label No. Order' },
      { key: 'qc.date',     label: 'Label Tanggal' },
      { key: 'qc.customer', label: 'Label Customer' },
      { key: 'qc.phone',    label: 'Label Telepon' },
      { key: 'qc.items',    label: 'Header Items' },
      { key: 'qc.qty',      label: 'Label Qty' },
      { key: 'qc.size',     label: 'Label Ukuran' },
      { key: 'qc.length',   label: 'Label Panjang' },
      { key: 'qc.finishing',label: 'Label Finishing' },
      { key: 'qc.status',   label: 'Label Status' },
      { key: 'qc.passed',   label: 'Teks QC Lulus' },
      { key: 'qc.failed',   label: 'Teks QC Gagal' },
      { key: 'qc.notes',    label: 'Label Catatan QC' },
      { key: 'qc.qcBy',     label: 'Label QC By' },
      { key: 'qc.payment',  label: 'Label Status Bayar' },
      { key: 'qc.paid',     label: 'Teks Lunas' },
      { key: 'qc.unpaid',   label: 'Teks Belum Bayar' },
      { key: 'qc.partial',  label: 'Teks DP / Partial' },
      { key: 'qc.endLabel', label: 'Teks Akhir Label' },
    ]},
  ];

  let currentCustomText = {};
  let customTextVisible = false;

  function toggleCustomText() {
    customTextVisible = !customTextVisible;
    document.getElementById('customTextBody').style.display = customTextVisible ? 'block' : 'none';
    document.getElementById('customTextToggle').textContent = customTextVisible ? '▲ Sembunyikan' : '▼ Tampilkan';
    if (customTextVisible && document.getElementById('customTextFields').childElementCount === 0) {
      renderCustomTextFields();
    }
  }

  // Ambil default value dari bahasa aktif (client-side translations tidak punya receipt.*,
  // jadi kita tampilkan placeholder dari server via currentCustomText)
  function renderCustomTextFields() {
    const container = document.getElementById('customTextFields');
    container.innerHTML = '';
    CUSTOM_TEXT_FIELDS.forEach(({ group, fields }) => {
      const groupEl = document.createElement('div');
      groupEl.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:0.05em;opacity:0.5;padding:6px 0 2px;';
      groupEl.textContent = group;
      container.appendChild(groupEl);
      fields.forEach(({ key, label }) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:160px 1fr;gap:8px;align-items:center;';
        const lbl = document.createElement('label');
        lbl.style.cssText = 'font-size:12px;opacity:0.75;';
        lbl.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.id = 'ct_' + key.replace('.', '_');
        inp.dataset.key = key;
        inp.value = currentCustomText[key] || '';
        inp.placeholder = '(default)';
        inp.style.cssText = 'background:#1a1d27;border:1px solid #2d3147;color:#e2e8f0;padding:5px 8px;border-radius:6px;font-size:12px;width:100%;';
        row.appendChild(lbl);
        row.appendChild(inp);
        container.appendChild(row);
      });
    });
  }

  async function loadCustomText() {
    try {
      const r = await fetch(BASE + '/settings/custom-text');
      const d = await r.json();
      if (d.success) {
        currentCustomText = d.customText || {};
        if (customTextVisible) renderCustomTextFields();
      }
    } catch (e) {
      console.error('Failed to load custom text:', e);
    }
  }

  async function saveCustomText() {
    const btn = document.getElementById('btnSaveCustomText');
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const payload = {};
      document.querySelectorAll('#customTextFields input[data-key]').forEach(inp => {
        payload[inp.dataset.key] = inp.value.trim();
      });
      const r = await fetch(BASE + '/settings/custom-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await r.json();
      if (d.success) {
        currentCustomText = d.customText || {};
        toast('Custom teks disimpan!', 'success');
        addLog('Custom teks disimpan', 'ok');
      } else {
        toast('Gagal menyimpan', 'error');
      }
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '💾 Simpan Custom Teks';
    }
  }

  // ── Init ──────────────────────────────────────────────
  async function init() {
    await loadSettings();
    await loadCustomText();
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

// Get custom text overrides
app.get('/settings/custom-text', (req, res) => {
  res.json({ success: true, customText });
});

// Update custom text overrides
app.post('/settings/custom-text', (req, res) => {
  try {
    const incoming = req.body;
    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ success: false, message: 'Invalid payload' });
    }
    // Allowed keys: only receipt.* and qc.*
    const allowed = /^(receipt|qc)\.[a-zA-Z]+$/;
    const updated = {};
    for (const [key, val] of Object.entries(incoming)) {
      if (allowed.test(key)) updated[key] = String(val);
    }
    customText = updated;
    saveConfig();
    res.json({ success: true, customText });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Get current settings (language, currency, paperWidth)
app.get('/settings/get', (req, res) => {
  res.json({
    success: true,
    language: currentLanguage,
    currency: currentCurrency,
    paperWidth: currentPaperWidth
  });
});

// Update settings (language, currency, paperWidth)
app.post('/settings/update', (req, res) => {
  try {
    const { language, currency, paperWidth } = req.body;

    if (language && ['id', 'en'].includes(language)) {
      currentLanguage = language;
    }

    if (currency && ['IDR', 'USD'].includes(currency)) {
      currentCurrency = currency;
    }

    if (paperWidth && [32, 48].includes(Number(paperWidth))) {
      currentPaperWidth = Number(paperWidth);
    }

    saveConfig(); // Save to file

    res.json({
      success: true,
      message: translations[currentLanguage].messages.settingsSaved,
      language: currentLanguage,
      currency: currentCurrency,
      paperWidth: currentPaperWidth
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update settings',
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

    // Print (dengan logo jika tersedia)
    const receiptText = createReceiptText(receiptData);
    const storeData = (receiptData.receiptData || receiptData).store;
    const finalBuffer = await buildReceiptBuffer(receiptText, storeData);
    await printToWindowsPrinter(currentPrinter, finalBuffer);

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
    const storeData = (receiptData.receiptData || receiptData).store;
    const finalBuffer = await buildReceiptBuffer(receiptText, storeData);
    await printToWindowsPrinter(currentPrinter, finalBuffer);

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