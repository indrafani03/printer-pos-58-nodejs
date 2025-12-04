# Test printing using .NET PrintQueue
$printerName = "POS58"
$testFile = "C:\Users\PT UMA\Documents\indrafani\printer\test_data.bin"

# Create test data
$data = [byte[]](0x1b,0x40) + [System.Text.Encoding]::ASCII.GetBytes("TEST FROM POWERSHELL`n`nHello World!`n`n`n`n") + [byte[]](0x1d,0x56,0x00)
[System.IO.File]::WriteAllBytes($testFile, $data)

Write-Host "Created test file: $testFile"
Write-Host "File size: $($data.Length) bytes"

# Method 1: Using Out-Printer cmdlet
Write-Host "`n=== Method 1: Out-Printer ==="
try {
    Get-Content $testFile -Raw | Out-Printer -Name $printerName
    Write-Host "✅ Out-Printer succeeded"
} catch {
    Write-Host "❌ Out-Printer failed: $_"
}

# Method 2: Using System.Drawing.Printing
Write-Host "`n=== Method 2: .NET PrintDocument ==="
try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Printing

    $printDoc = New-Object System.Drawing.Printing.PrintDocument
    $printDoc.PrinterSettings.PrinterName = $printerName

    # Read raw data
    $rawData = [System.IO.File]::ReadAllBytes($testFile)

    # Send raw bytes
    $printDoc.PrintPage.Add({
        param($sender, $e)
        # This won't work perfectly for raw ESC/POS, but let's try
        $e.Graphics.DrawString([System.Text.Encoding]::ASCII.GetString($rawData),
            (New-Object System.Drawing.Font("Courier New", 10)),
            [System.Drawing.Brushes]::Black,
            10, 10)
    })

    $printDoc.Print()
    Write-Host "✅ .NET PrintDocument succeeded"
} catch {
    Write-Host "❌ .NET PrintDocument failed: $_"
}

# Cleanup
Remove-Item $testFile -ErrorAction SilentlyContinue
