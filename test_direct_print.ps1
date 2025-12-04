param(
    [string]$PrinterName = "POS58(2)",
    [string]$TextContent = "TEST PRINT`r`n=================================`r`nTanggal: $(Get-Date)`r`nPrinter: POS58(2)`r`n=================================`r`n`r`nTest berhasil!`r`n`r`nTerima kasih!`r`n"
)

# Create temp file
$tempFile = Join-Path $env:TEMP "printer_test_$(Get-Random).txt"
$TextContent | Out-File -FilePath $tempFile -Encoding utf8

# Print to printer
try {
    Get-Content $tempFile | Out-Printer -Name $PrinterName
    Write-Host "✅ Print successful to $PrinterName"
} catch {
    Write-Error "❌ Print failed: $_"
} finally {
    # Clean up
    if (Test-Path $tempFile) {
        Remove-Item $tempFile -Force
    }
}
