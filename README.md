# Thermal Printer Service API

API service untuk thermal printer RPP02N menggunakan Node.js dan Express. Service ini dapat dikonfigurasi untuk auto-start saat komputer hidup menggunakan Windows Service.

## Fitur

- RESTful API untuk operasi printer thermal
- Komunikasi serial/Bluetooth dengan printer
- Auto-discovery port printer
- Format receipt dengan ESC/POS commands
- Auto-start saat Windows boot (opsional)

## Instalasi

### 1. Install Dependencies

```bash
npm install
```

### 2. Jalankan Server (Manual)

```bash
node index.js
```

Server akan berjalan di `http://localhost:5000`

## Auto-Start Service (Recommended)

Untuk membuat service otomatis start saat komputer hidup, gunakan Windows Service.

### Install Service

**PENTING: Jalankan sebagai Administrator**

1. Buka Command Prompt atau PowerShell **sebagai Administrator**:
   - Klik kanan Command Prompt/PowerShell
   - Pilih "Run as administrator"

2. Navigate ke folder project:
   ```bash
   cd C:\Users\PT UMA\Documents\indrafani\printer
   ```

3. Install service:
   ```bash
   node install-service.js
   ```

4. Service akan otomatis:
   - Terdaftar di Windows Services dengan nama "Thermal Printer Service"
   - Start otomatis saat komputer boot
   - Running di background
   - Server available di `http://localhost:5000`

### Uninstall Service

**PENTING: Jalankan sebagai Administrator**

```bash
node uninstall-service.js
```

### Manage Service

Setelah service terinstall, Anda bisa manage service melalui:

**1. Windows Services (services.msc)**
- Tekan `Win + R`
- Ketik `services.msc`
- Cari "Thermal Printer Service"
- Klik kanan untuk:
  - Start/Stop/Restart service
  - Lihat properties
  - Change startup type

**2. Task Manager**
- Buka Task Manager (`Ctrl + Shift + Esc`)
- Tab "Services"
- Cari "Thermal Printer Service"

**3. Command Line (sebagai Administrator)**
```bash
# Start service
net start "Thermal Printer Service"

# Stop service
net stop "Thermal Printer Service"

# Restart service
net stop "Thermal Printer Service" && net start "Thermal Printer Service"

# Check status
sc query "Thermal Printer Service"
```

## API Endpoints

### Printer Management

**Scan Available Ports**
```http
GET /printer/ports
```

**Connect to Printer**
```http
POST /printer/connect
Content-Type: application/json

{
  "port": "COM3",  // Optional, auto-detect jika tidak diisi
  "baudRate": 9600
}
```

**Check Connection Status**
```http
GET /printer/status
```

**Disconnect Printer**
```http
POST /printer/disconnect
```

### Printing Operations

**Print Receipt**
```http
POST /print/receipt
Content-Type: application/json

{
  "storeName": "TOKO SAYA",
  "address": "Jl. Contoh No. 123",
  "date": "2025-12-05",
  "transactionId": "TRX001",
  "cashier": "John",
  "customer": "Jane",
  "items": [
    {
      "name": "Produk A",
      "qty": 2,
      "price": 50000
    }
  ],
  "total": 100000,
  "payment": 150000,
  "change": 50000
}
```

**Print Test Page**
```http
POST /print/test
```

**Print Simple Text**
```http
POST /print/text
Content-Type: application/json

{
  "text": "Hello World"
}
```

**Print Raw ESC/POS**
```http
POST /print/raw
Content-Type: application/json

{
  "commands": ["\x1B\x40", "\x1B\x61\x01", "CENTER TEXT", "\x0A"]
}
```

## Troubleshooting

### Service tidak start

1. **Check Event Viewer**:
   - Tekan `Win + R` → ketik `eventvwr.msc`
   - Navigate: Windows Logs → Application
   - Cari error dari "Thermal Printer Service"

2. **Check Permissions**:
   - Pastikan install service sebagai Administrator
   - Check read/write permissions di folder project

3. **Check Node.js**:
   ```bash
   node --version
   ```
   Pastikan Node.js terinstall dan accessible dari PATH

### Printer tidak terdeteksi

1. **Check USB/Bluetooth Connection**:
   - Pastikan printer terhubung
   - Check di Device Manager (devmgmt.msc)
   - Lihat di Ports (COM & LPT)

2. **Scan Ports**:
   ```bash
   curl http://localhost:5000/printer/ports
   ```

3. **Test Connection**:
   - Gunakan endpoint `/printer/connect`
   - Check response error message

### Service running tapi tidak bisa connect

1. **Check Port**:
   - Pastikan service running di port 5000
   - Check dengan: `netstat -ano | findstr :5000`

2. **Check Firewall**:
   - Windows Defender Firewall
   - Allow Node.js untuk network access

3. **Restart Service**:
   ```bash
   net stop "Thermal Printer Service"
   net start "Thermal Printer Service"
   ```

## Dependencies

- `express` - Web framework
- `serialport` - Serial/USB/Bluetooth communication
- `cors` - CORS support
- `node-windows` - Windows Service management

## Technical Details

- **Paper Width**: 58mm (32 characters)
- **Printer Model**: RPP02N Thermal Printer
- **Command Set**: ESC/POS
- **Default Port**: 5000
- **Baud Rate**: 9600 (default)

## Environment Variables

```bash
PORT=5000           # Server port (default: 5000)
NODE_ENV=production # Environment mode
```

## Development

Untuk development tanpa install service:

```bash
# Development mode
node index.js

# Atau gunakan nodemon
npm install -g nodemon
nodemon index.js
```

## License

ISC

## Support

Untuk pertanyaan atau issue, hubungi developer atau buat issue di repository.
