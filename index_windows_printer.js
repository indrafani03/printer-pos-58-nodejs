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

// Function untuk print ke Windows printer menggunakan raw data
function printToWindowsPrinter(printerName, data) {
  return new Promise((resolve, reject) => {
    // Create temp file dengan raw data
    const tempFile = path.join(os.tmpdir(), `print_${Date.now()}.txt`);

    try {
      // Write binary data to file
      fs.writeFileSync(tempFile, data, 'binary');
    } catch (err) {
      reject(new Error(`Failed to create temp file: ${err.message}`));
      return;
    }

    // PowerShell script untuk raw print
    const psScript = `
      $PrinterName = "${printerName}"
      $FilePath = "${tempFile.replace(/\\/g, '\\\\')}"

      # Baca file sebagai bytes
      $bytes = [System.IO.File]::ReadAllBytes($FilePath)

      # Buat print job
      $printerPath = "\\\\localhost\\$PrinterName"

      try {
        # Gunakan .NET printing
        Add-Type -AssemblyName System.Drawing
        Add-Type -AssemblyName System.Printing

        $PrintQueue = New-Object System.Printing.LocalPrintServer
        $Printer = $PrintQueue.GetPrintQueue($PrinterName)

        $PrintJob = $Printer.AddJob("Receipt")
        $Stream = $PrintJob.JobStream
        $Stream.Write($bytes, 0, $bytes.Length)
        $Stream.Close()

        Write-Output "SUCCESS"
      } catch {
        # Fallback: gunakan copy command
        Copy-Item -Path $FilePath -Destination $printerPath -ErrorAction Stop
        Write-Output "SUCCESS"
      }
    `;

    const psFile = path.join(os.tmpdir(), `print_script_${Date.now()}.ps1`);
    fs.writeFileSync(psFile, psScript, 'utf8');

    // Execute PowerShell
    exec(`powershell -ExecutionPolicy Bypass -File "${psFile}"`, {
      timeout: 30000
    }, (error, stdout, stderr) => {
      // Cleanup
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        if (fs.existsSync(psFile)) fs.unlinkSync(psFile);
      } catch (e) {
        console.log('Cleanup warning:', e.message);
      }

      if (error) {
        reject(new Error(`Print failed: ${error.message}`));
        return;
      }

      if (stdout.includes('SUCCESS')) {
        resolve('Print successful');
      } else {
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

// ===========================================
// API ENDPOINTS
// ===========================================

// Get available printers
app.get('/printer/ports', async (req, res) => {
  exec('powershell "Get-Printer | Select-Object Name, PortName, DriverName | ConvertTo-Json"', (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: 'Failed to get printers',
        error: error.message
      });
    }

    try {
      const printers = JSON.parse(stdout);
      const printerList = Array.isArray(printers) ? printers : [printers];

      res.json({
        success: true,
        ports: printerList.map(p => ({
          path: p.Name,
          manufacturer: p.DriverName,
          port: p.PortName
        }))
      });
    } catch (e) {
      res.status(500).json({
        success: false,
        message: 'Failed to parse printers',
        error: e.message
      });
    }
  });
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
    port: currentPrinter
  });
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

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🖨️  Windows Printer API Server running on port ${PORT}`);
  console.log(`📋 Current printer: ${currentPrinter}`);
  console.log("\n📋 Available endpoints:");
  console.log("GET  /printer/ports - Get available Windows printers");
  console.log("POST /printer/connect - Set active printer");
  console.log("GET  /printer/status - Check printer status");
  console.log("GET  /print/receipt - Print receipt");
  console.log("POST /print/test - Test print");
  console.log("POST /print/text - Print simple text");
  console.log("\n✅ This version uses Windows Print Spooler");
  console.log("✅ Works with USB printers on CP ports");
  console.log("✅ No COM port required!");
});
