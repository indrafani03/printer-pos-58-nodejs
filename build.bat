@echo off
setlocal EnableDelayedExpansion
title Build Thermal Printer Service Installer

echo ============================================
echo   Build Thermal Printer Service Installer
echo ============================================
echo.

:: Cek apakah node tersedia
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js tidak ditemukan!
    echo Silakan install Node.js dari https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set NODE_VERSION=%%v
echo [OK] Node.js: %NODE_VERSION%

:: Buat folder dist jika belum ada
if not exist dist mkdir dist
echo [OK] Folder dist siap

:: Install dependencies jika node_modules belum ada
if not exist node_modules (
    echo.
    echo [INFO] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install gagal!
        pause
        exit /b 1
    )
)

:: Install pkg (gunakan @yao-pkg/pkg yang support Node terbaru)
echo.
echo [INFO] Memeriksa pkg...
call npx @yao-pkg/pkg --version >nul 2>&1
if errorlevel 1 (
    echo [INFO] Menginstall @yao-pkg/pkg...
    call npm install --save-dev @yao-pkg/pkg
    if errorlevel 1 (
        echo [WARN] @yao-pkg/pkg gagal, mencoba pkg biasa...
        call npm install --save-dev pkg
    )
)

:: Build executable dengan pkg
echo.
echo [INFO] Membangun printer-service.exe...
echo       (Proses ini bisa memakan waktu 1-3 menit, harap tunggu)
echo.

:: Coba @yao-pkg/pkg dulu
call npx @yao-pkg/pkg index.js --target node18-win-x64 --output dist\printer-service.exe 2>nul
if errorlevel 1 (
    :: Fallback ke pkg biasa
    call npx pkg index.js --target node18-win-x64 --output dist\printer-service.exe
    if errorlevel 1 (
        echo [ERROR] Build exe gagal!
        echo Pastikan tidak ada error di index.js
        pause
        exit /b 1
    )
)

echo.
echo [OK] printer-service.exe berhasil dibuat!

:: Copy file pendukung ke dist
echo.
echo [INFO] Menyalin file pendukung...

copy /Y raw_print.ps1 dist\raw_print.ps1 >nul
echo [OK] raw_print.ps1 disalin

if exist printer_config.json (
    copy /Y printer_config.json dist\printer_config.json >nul
    echo [OK] printer_config.json disalin
) else (
    :: Buat config default
    echo { > dist\printer_config.json
    echo   "currentPrinter": "POS58", >> dist\printer_config.json
    echo   "autoReconnectEnabled": false, >> dist\printer_config.json
    echo   "language": "id", >> dist\printer_config.json
    echo   "currency": "IDR" >> dist\printer_config.json
    echo } >> dist\printer_config.json
    echo [OK] printer_config.json default dibuat
)

echo.
echo ============================================
echo   HASIL BUILD:
echo ============================================
dir /b dist\
echo.

:: Cek apakah Inno Setup tersedia untuk membuat installer .exe
echo [INFO] Mencari Inno Setup untuk membuat installer .exe...

set ISCC=""
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
    set ISCC="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
)
if exist "C:\Program Files\Inno Setup 6\ISCC.exe" (
    set ISCC="C:\Program Files\Inno Setup 6\ISCC.exe"
)
if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" (
    set ISCC="%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
)

if %ISCC% == "" (
    echo.
    echo ============================================
    echo   INNO SETUP TIDAK DITEMUKAN
    echo ============================================
    echo.
    echo File printer-service.exe sudah dibuat di folder dist\.
    echo.
    echo Untuk membuat installer .exe yang bisa didistribusikan:
    echo.
    echo 1. Download dan install Inno Setup 6 dari:
    echo    https://jrsoftware.org/isdl.php
    echo.
    echo 2. Setelah install, jalankan build.bat lagi
    echo    ATAU buka installer.iss di Inno Setup dan klik Compile
    echo.
    echo ALTERNATIF - Install manual tanpa installer:
    echo   Jalankan install-manual.bat sebagai Administrator
    echo.
    pause
    exit /b 0
)

:: Build installer dengan Inno Setup
echo [INFO] Membangun installer dengan Inno Setup...
call %ISCC% installer.iss

if errorlevel 1 (
    echo [ERROR] Pembuatan installer gagal!
    pause
    exit /b 1
)

echo.
echo ============================================
echo   BUILD SELESAI!
echo ============================================
echo.
echo Installer tersedia di:
echo   dist\PrinterServiceInstaller.exe
echo.
echo Jalankan PrinterServiceInstaller.exe sebagai Administrator
echo untuk menginstall service di komputer target.
echo.
pause
