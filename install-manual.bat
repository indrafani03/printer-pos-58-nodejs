@echo off
:: Script untuk install tanpa Inno Setup - jalankan sebagai Administrator
setlocal EnableDelayedExpansion
title Install Thermal Printer Service

:: Cek administrator
net session >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Script ini harus dijalankan sebagai Administrator!
    echo Klik kanan pada file ini, lalu pilih "Run as administrator"
    pause
    exit /b 1
)

echo ============================================
echo   Install Thermal Printer Service
echo ============================================
echo.

set SERVICE_NAME=ThermalPrinterService
set SERVICE_DISPLAY=Thermal Printer Service
set INSTALL_DIR=%ProgramFiles%\PrinterService
set EXE_NAME=printer-service.exe

:: Cek file exe ada
if not exist "dist\%EXE_NAME%" (
    echo [ERROR] dist\%EXE_NAME% tidak ditemukan!
    echo Jalankan build.bat terlebih dahulu.
    pause
    exit /b 1
)

:: Buat folder instalasi
echo [INFO] Membuat folder: %INSTALL_DIR%
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

:: Stop dan hapus service lama jika ada
echo [INFO] Menghapus service lama jika ada...
sc stop "%SERVICE_NAME%" >nul 2>&1
timeout /t 2 /nobreak >nul
sc delete "%SERVICE_NAME%" >nul 2>&1
timeout /t 1 /nobreak >nul

:: Copy file ke folder instalasi
echo [INFO] Menyalin file...
copy /Y "dist\%EXE_NAME%" "%INSTALL_DIR%\%EXE_NAME%" >nul
copy /Y "raw_print.ps1" "%INSTALL_DIR%\raw_print.ps1" >nul

if exist "printer_config.json" (
    if not exist "%INSTALL_DIR%\printer_config.json" (
        copy "printer_config.json" "%INSTALL_DIR%\printer_config.json" >nul
    )
)

echo [OK] File disalin ke %INSTALL_DIR%

:: Daftarkan Windows Service
echo [INFO] Mendaftarkan Windows Service...
sc create "%SERVICE_NAME%" binPath= "\"%INSTALL_DIR%\%EXE_NAME%\"" start= auto DisplayName= "%SERVICE_DISPLAY%"
if errorlevel 1 (
    echo [ERROR] Gagal mendaftarkan service!
    pause
    exit /b 1
)

:: Tambah deskripsi
sc description "%SERVICE_NAME%" "Thermal Printer API Service - REST API for thermal printer on port 5000"

:: Set recovery action (restart otomatis jika crash)
sc failure "%SERVICE_NAME%" reset= 86400 actions= restart/5000/restart/10000/restart/30000

:: Jalankan service
echo [INFO] Menjalankan service...
sc start "%SERVICE_NAME%"
if errorlevel 1 (
    echo [WARN] Service gagal start, coba jalankan manual dari Services.msc
) else (
    echo [OK] Service berhasil dijalankan!
)

:: Tunggu sebentar lalu cek status
timeout /t 3 /nobreak >nul
sc query "%SERVICE_NAME%"

echo.
echo ============================================
echo   INSTALASI SELESAI!
echo ============================================
echo.
echo Service: %SERVICE_DISPLAY%
echo Status:  Auto-start (berjalan saat Windows nyala)
echo URL:     http://localhost:5000
echo.
echo Untuk mengelola service:
echo   Buka Services.msc dan cari "%SERVICE_DISPLAY%"
echo.
pause
