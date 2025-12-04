# Raw printer using Win32 API
param(
    [string]$PrinterName = "POS58",
    [string]$DataFile = ""
)

# Win32 API untuk raw printing
$code = @'
using System;
using System.Runtime.InteropServices;
using System.IO;

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

    public static bool SendBytesToPrinter(string szPrinterName, byte[] pBytes)
    {
        IntPtr pUnmanagedBytes = IntPtr.Zero;
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        bool bSuccess = false;

        di.pDocName = "Raw Document";
        di.pDataType = "RAW";

        try
        {
            if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero))
            {
                if (StartDocPrinter(hPrinter, 1, di))
                {
                    if (StartPagePrinter(hPrinter))
                    {
                        pUnmanagedBytes = Marshal.AllocCoTaskMem(pBytes.Length);
                        Marshal.Copy(pBytes, 0, pUnmanagedBytes, pBytes.Length);

                        Int32 dwWritten = 0;
                        bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, pBytes.Length, out dwWritten);

                        EndPagePrinter(hPrinter);
                    }
                    EndDocPrinter(hPrinter);
                }
                ClosePrinter(hPrinter);
            }
        }
        finally
        {
            if (pUnmanagedBytes != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pUnmanagedBytes);
            }
        }

        return bSuccess;
    }
}
'@

try {
    # Compile the C# code
    Add-Type -TypeDefinition $code -Language CSharp

    # Read data from file or use test data
    if ($DataFile -and (Test-Path $DataFile)) {
        $data = [System.IO.File]::ReadAllBytes($DataFile)
        Write-Host "Read $($data.Length) bytes from $DataFile"
    } else {
        # Create test data with ESC/POS commands
        $ESC = [byte]0x1b
        $GS = [byte]0x1d
        $LF = [byte]0x0a

        $data = @()
        $data += $ESC, 0x40  # ESC @ - Initialize
        $data += [System.Text.Encoding]::ASCII.GetBytes("TEST PRINT`n")
        $data += [System.Text.Encoding]::ASCII.GetBytes("================================`n")
        $data += [System.Text.Encoding]::ASCII.GetBytes("Tanggal: $((Get-Date).ToString())`n")
        $data += [System.Text.Encoding]::ASCII.GetBytes("Printer: $PrinterName`n")
        $data += [System.Text.Encoding]::ASCII.GetBytes("================================`n`n")
        $data += [System.Text.Encoding]::ASCII.GetBytes("Test berhasil!`n`n`n")
        $data += $GS, 0x56, 0x00  # GS V 0 - Cut paper

        Write-Host "Created test data: $($data.Length) bytes"
    }

    # Send to printer
    Write-Host "Sending to printer: $PrinterName"
    $result = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $data)

    if ($result) {
        Write-Output "Print successful"
        exit 0
    } else {
        Write-Output "Print failed"
        exit 1
    }

} catch {
    Write-Output "Error: $_"
    exit 1
}
