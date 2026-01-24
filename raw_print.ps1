# Raw printer using Win32 API with retry and spooler management
param(
    [string]$PrinterName = "POS58",
    [string]$DataFile = "",
    [int]$MaxRetries = 3
)

# Function to wait for pending jobs to complete
function Wait-PrinterReady {
    param([string]$Printer, [int]$MaxWaitSeconds = 10)

    $waited = 0
    while ($waited -lt $MaxWaitSeconds) {
        try {
            $jobs = Get-PrintJob -PrinterName $Printer -ErrorAction SilentlyContinue
            if (-not $jobs -or $jobs.Count -eq 0) {
                return $true
            }
            Write-Host "Waiting for $($jobs.Count) job(s) to complete..."
            Start-Sleep -Seconds 1
            $waited++
        } catch {
            return $true
        }
    }
    return $false
}

# Function to clear print jobs
function Clear-PrinterJobs {
    param([string]$Printer)

    try {
        $jobs = Get-PrintJob -PrinterName $Printer -ErrorAction SilentlyContinue
        if ($jobs) {
            Write-Host "Clearing $($jobs.Count) stuck job(s)..."
            $jobs | Remove-PrintJob -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        }
    } catch {
        Write-Host "Note: Could not check print jobs: $_"
    }
}

# Function to restart print spooler if needed
function Reset-PrintSpooler {
    try {
        $spooler = Get-Service -Name Spooler
        if ($spooler.Status -ne 'Running') {
            Write-Host "Restarting Print Spooler service..."
            Restart-Service -Name Spooler -Force
            Start-Sleep -Seconds 2
        }
    } catch {
        Write-Host "Note: Could not check spooler: $_"
    }
}

# Win32 API untuk raw printing
$code = @'
using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)]
        public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)]
        public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)]
        public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint = "ClosePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint = "EndDocPrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "StartPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "EndPagePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint = "WritePrinter", SetLastError = true, ExactSpelling = true, CallingConvention = CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);

    public static int SendBytesToPrinter(string szPrinterName, byte[] pBytes)
    {
        IntPtr pUnmanagedBytes = IntPtr.Zero;
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        int errorCode = 0;

        di.pDocName = "Receipt_" + DateTime.Now.ToString("yyyyMMdd_HHmmss");
        di.pDataType = "RAW";

        try
        {
            if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero))
            {
                errorCode = Marshal.GetLastWin32Error();
                Console.WriteLine("OpenPrinter failed. Error: " + errorCode);
                return errorCode > 0 ? errorCode : 1;
            }

            if (!StartDocPrinter(hPrinter, 1, di))
            {
                errorCode = Marshal.GetLastWin32Error();
                Console.WriteLine("StartDocPrinter failed. Error: " + errorCode);
                ClosePrinter(hPrinter);
                return errorCode > 0 ? errorCode : 2;
            }

            if (!StartPagePrinter(hPrinter))
            {
                errorCode = Marshal.GetLastWin32Error();
                Console.WriteLine("StartPagePrinter failed. Error: " + errorCode);
                EndDocPrinter(hPrinter);
                ClosePrinter(hPrinter);
                return errorCode > 0 ? errorCode : 3;
            }

            pUnmanagedBytes = Marshal.AllocCoTaskMem(pBytes.Length);
            Marshal.Copy(pBytes, 0, pUnmanagedBytes, pBytes.Length);

            Int32 dwWritten = 0;
            bool writeSuccess = WritePrinter(hPrinter, pUnmanagedBytes, pBytes.Length, out dwWritten);

            if (!writeSuccess || dwWritten != pBytes.Length)
            {
                errorCode = Marshal.GetLastWin32Error();
                Console.WriteLine("WritePrinter failed. Written: " + dwWritten + "/" + pBytes.Length + " Error: " + errorCode);
            }

            // Cleanup - minimal delays
            Thread.Sleep(50); // Brief wait for data to be sent
            EndPagePrinter(hPrinter);
            Thread.Sleep(50); // Brief delay before ending doc
            EndDocPrinter(hPrinter);
            Thread.Sleep(100); // Brief delay before closing
            ClosePrinter(hPrinter);
            hPrinter = IntPtr.Zero;

            return writeSuccess && dwWritten == pBytes.Length ? 0 : (errorCode > 0 ? errorCode : 4);
        }
        catch (Exception ex)
        {
            Console.WriteLine("Exception: " + ex.Message);
            return 99;
        }
        finally
        {
            if (pUnmanagedBytes != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pUnmanagedBytes);
            }
            if (hPrinter != IntPtr.Zero)
            {
                try { ClosePrinter(hPrinter); } catch { }
            }
        }
    }
}
'@

try {
    # Check spooler service
    Reset-PrintSpooler

    # Wait for any pending jobs to complete
    $ready = Wait-PrinterReady -Printer $PrinterName -MaxWaitSeconds 3
    if (-not $ready) {
        Write-Host "Printer busy, clearing stuck jobs..."
        Clear-PrinterJobs -Printer $PrinterName
    }

    # Compile the C# code
    Add-Type -TypeDefinition $code -Language CSharp -ErrorAction SilentlyContinue

    # Read data from file
    if ($DataFile -and (Test-Path $DataFile)) {
        $data = [System.IO.File]::ReadAllBytes($DataFile)
        Write-Host "Read $($data.Length) bytes from file"
    } else {
        Write-Output "Error: Data file not found"
        exit 1
    }

    # Retry loop
    $success = $false
    $lastError = 0

    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        Write-Host "Print attempt $attempt of $MaxRetries..."

        $result = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $data)

        if ($result -eq 0) {
            $success = $true
            Write-Host "Print successful on attempt $attempt"
            # Brief wait for printer to finish processing
            Start-Sleep -Milliseconds 200
            break
        } else {
            $lastError = $result
            Write-Host "Attempt $attempt failed with code: $result"

            if ($attempt -lt $MaxRetries) {
                Write-Host "Waiting before retry..."
                Start-Sleep -Milliseconds 500

                # Clear jobs and wait for printer ready before retry
                Clear-PrinterJobs -Printer $PrinterName
                Wait-PrinterReady -Printer $PrinterName -MaxWaitSeconds 2 | Out-Null
            }
        }
    }

    if ($success) {
        Write-Output "Print successful"
        exit 0
    } else {
        Write-Output "Print failed after $MaxRetries attempts. Last error: $lastError"
        exit 1
    }

} catch {
    Write-Output "Error: $_"
    exit 1
}
