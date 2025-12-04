# Auto-Connect Feature Documentation

## Overview
Printer service sekarang dilengkapi dengan fitur **auto-connect** dan **auto-reconnect** yang canggih untuk USB dan Bluetooth printer.

## Fitur Utama

### 1. Auto-Connect saat Startup
- Server secara otomatis mencari dan menghubungkan ke printer saat startup
- Mendukung koneksi USB dan Bluetooth
- **Prioritas koneksi**: USB > Bluetooth
- Retry mechanism dengan 3 percobaan (delay 3 detik antar percobaan)

### 2. Auto-Reconnect
- Otomatis mencoba reconnect ketika koneksi terputus
- Monitoring setiap 5 detik untuk mencari printer yang tersedia
- Prioritas reconnect ke port terakhir yang berhasil connect
- Berjalan di background tanpa mengganggu operasi lain

### 3. Smart Port Detection
- Otomatis mendeteksi COM ports (Windows)
- Mengenali USB printer (Prolific, FTDI chipset)
- Mengenali Bluetooth Serial ports
- Sorting otomatis berdasarkan prioritas (USB first, then Bluetooth)

### 4. Connection Monitoring
- Real-time monitoring status koneksi
- Event handler untuk disconnect dan error
- Automatic recovery mechanism

## Cara Kerja

### Skenario 1: Startup dengan Printer Terhubung
```
1. Server start
2. Scan ports (mencari USB/Bluetooth printer)
3. Connect ke port pertama dengan prioritas tertinggi (USB > Bluetooth)
4. Status: CONNECTED
```

### Skenario 2: Startup tanpa Printer
```
1. Server start
2. Scan ports (tidak menemukan printer)
3. Retry 3x dengan delay 3 detik
4. Start background monitoring
5. Terus mencoba connect setiap 5 detik di background
6. Otomatis connect saat printer tersedia
```

### Skenario 3: Disconnect saat Running
```
1. Printer disconnect (cabut USB/Bluetooth off)
2. Event 'close' detected
3. Start auto-reconnect monitor
4. Mencoba reconnect ke last known port setiap 5 detik
5. Otomatis connect saat printer tersedia lagi
```

## API Endpoints

### 1. Check Status
```http
GET /printer/status
```
Response:
```json
{
  "success": true,
  "connected": true,
  "port": "COM3",
  "lastConnectedPort": "COM3",
  "autoReconnectEnabled": true,
  "isMonitoring": false
}
```

### 2. Manual Connect
```http
POST /printer/connect
Content-Type: application/json

{
  "port": "COM3",
  "baudRate": 9600
}
```

Atau auto-detect (tanpa parameter port):
```http
POST /printer/connect
Content-Type: application/json

{}
```

### 3. Disconnect
```http
POST /printer/disconnect
Content-Type: application/json

{
  "disableAutoReconnect": false
}
```

Parameters:
- `disableAutoReconnect` (optional, boolean): Set `true` untuk disable auto-reconnect setelah disconnect

### 4. Toggle Auto-Reconnect
```http
POST /printer/auto-reconnect
Content-Type: application/json

{
  "enabled": true
}
```

## Setup Instructions

### Untuk Koneksi Bluetooth:
1. Buka Windows Bluetooth Settings
2. Pair printer RPP02N
3. Pastikan printer dalam status "Connected"
4. Start server → otomatis connect

### Untuk Koneksi USB:
1. Colokkan printer ke USB port
2. Install driver jika diperlukan (biasanya otomatis)
3. Start server → otomatis connect

## Konfigurasi

### Global Variables (di index.js):
```javascript
let autoReconnectEnabled = true;  // Enable/disable auto-reconnect
let reconnectInterval = null;      // Monitor interval handler
let lastConnectedPort = null;      // Last successful connection
```

### Timing Configuration:
- **Startup retry delay**: 3 detik
- **Startup max retries**: 3 kali
- **Background monitoring interval**: 5 detik
- **Connection timeout**: Default serialport timeout

## Troubleshooting

### Printer tidak terdeteksi
**Solusi:**
1. Pastikan printer ON
2. Untuk Bluetooth: Check pairing di Windows Settings
3. Untuk USB: Check Device Manager untuk COM port
4. Restart service
5. Check logs untuk error messages

### Auto-reconnect tidak bekerja
**Solusi:**
1. Check status: `GET /printer/status`
2. Pastikan `autoReconnectEnabled: true`
3. Check `isMonitoring` status
4. Enable manual: `POST /printer/auto-reconnect` dengan `{"enabled": true}`

### Multiple printers terdeteksi
**Behavior:**
- Server akan connect ke printer dengan prioritas tertinggi
- Prioritas: USB > Bluetooth
- Untuk connect ke printer tertentu, gunakan manual connect dengan parameter port

### Connection unstable
**Tips:**
1. Untuk USB: Gunakan kabel USB berkualitas baik
2. Untuk Bluetooth: Pastikan jarak < 10 meter dan tidak ada obstacle
3. Check power supply printer
4. Restart printer dan service

## Log Messages

### Success Messages:
- `✅ Auto-connected to printer on COM3`
- `✅ Reconnected successfully!`
- `🟢 Auto-reconnect enabled`

### Error Messages:
- `❌ No printer ports found`
- `❌ Failed to connect to COM3: [error]`
- `⚠️  Printer disconnected`

### Info Messages:
- `🔍 Scanning for printer ports...`
- `🔗 Attempting to connect to COM3...`
- `🔄 Attempting to reconnect to printer...`
- `⏳ Waiting 3 seconds before retry...`

## Performance

- **Port scanning**: ~100-500ms
- **Connection establishment**: ~500-2000ms
- **Background monitoring overhead**: Minimal (runs every 5s)
- **Memory usage**: Negligible (~1-2MB for monitoring)

## Best Practices

1. **Untuk Production:**
   - Keep auto-reconnect enabled
   - Monitor logs untuk connection issues
   - Set up alerts untuk connection failures

2. **Untuk Development:**
   - Dapat disable auto-reconnect jika testing disconnect scenarios
   - Gunakan manual connect untuk testing specific ports

3. **Untuk Testing:**
   - Gunakan `/printer/status` untuk verify connection
   - Test disconnect/reconnect cycle
   - Verify print operations after reconnect

## Compatibility

- ✅ Windows (COM ports)
- ✅ USB Serial (Prolific, FTDI, CH340)
- ✅ Bluetooth Serial (SPP profile)
- ✅ RPP02N Thermal Printer
- ⚠️ Linux/Mac (experimental, may need adjustments)
