// Test script untuk print langsung ke Windows printer
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Fungsi untuk print ke Windows printer menggunakan PowerShell
function printToWindowsPrinter(printerName, textContent) {
  return new Promise((resolve, reject) => {
    // Buat temporary file
    const tempFile = path.join(__dirname, 'temp_print.txt');

    // Write content to temp file
    fs.writeFileSync(tempFile, textContent, 'utf8');

    // PowerShell command untuk print
    const psCommand = `
      Out-File -FilePath '${tempFile}' -InputObject '${textContent}' -Encoding utf8
      Get-Content '${tempFile}' | Out-Printer -Name '${printerName}'
      Write-Output 'Print job sent successfully'
    `;

    exec(`powershell -Command "${psCommand.replace(/\n/g, '; ').replace(/'/g, "''")}"`, (error, stdout, stderr) => {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        console.log('Failed to delete temp file:', e.message);
      }

      if (error) {
        reject(new Error(`Print failed: ${error.message}`));
        return;
      }

      if (stderr) {
        reject(new Error(`Print error: ${stderr}`));
        return;
      }

      resolve(stdout);
    });
  });
}

// Test print
async function testPrint() {
  try {
    console.log('Testing print to POS58(2)...');

    const testText = `
TEST PRINT
=================================
Tanggal: ${new Date().toLocaleString('id-ID')}
Printer: POS58(2)
Port: CP002
=================================

Test berhasil!

Terima kasih!
    `;

    const result = await printToWindowsPrinter('POS58(2)', testText);
    console.log('Print result:', result);
    console.log('✅ Print successful!');

  } catch (error) {
    console.error('❌ Print failed:', error.message);
  }
}

testPrint();
