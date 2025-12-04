# Dokumentasi Finishing dan Diskon - Thermal Printer API

## Fitur yang Sudah Terintegrasi

### ✅ 1. Finishing per Item
Setiap item dapat memiliki multiple finishing yang akan ditampilkan dengan indent di bawah item tersebut.

**Format Data:**
```json
{
  "name": "FLEXY 340GR (HIGH RES)",
  "quantity": 1,
  "price": 20000,
  "finishings": [
    { "name": "Test 1", "price": 1000 },
    { "name": "Laminating", "price": 2000 }
  ]
}
```

**Tampilan di Struk:**
```
FLEXY 340GR (HIGH RES)
  1 x Rp 20.000        Rp 20.000
    + Test 1            Rp 1.000
    + Laminating        Rp 2.000
  Subtotal item:       Rp 23.000
```

### ✅ 2. Subtotal per Item
Subtotal otomatis dihitung: `(Harga Item × Quantity) + Total Finishing`

### ✅ 3. Diskon
Diskon ditampilkan dengan tanda minus (-) sebelum total akhir.

**Format Data:**
```json
{
  "subtotal": 43500,
  "discountAmount": 5000,
  "totalAmount": 42850
}
```

**Tampilan di Struk:**
```
Subtotal:              Rp 43.500
Diskon:                -Rp 5.000
TOTAL:                 Rp 42.850
```

### ✅ 4. PPN (Pajak)
PPN ditampilkan terpisah sebelum diskon.

**Tampilan di Struk:**
```
Subtotal:              Rp 43.500
PPN:                    Rp 4.350
Diskon:                -Rp 5.000
TOTAL:                 Rp 42.850
```

## Struktur Data Lengkap

```json
{
  "store": {
    "name": "Printing Express",
    "address": "Jl. Eastern Boulevard, Sampora, Kec. Cisauk, Kabupaten Tangerang, Banten 15345",
    "phone": "626262626212"
  },
  "receiptNumber": "RCP-PIO-20251204-716289-7X7XGC",
  "orderNumber": "PTI/ODR/2511/00046",
  "customerName": "Wartini",
  "customerPhone": "132123123",
  "items": [
    {
      "name": "FLEXY 340GR (HIGH RES)",
      "quantity": 1,
      "price": 20000,
      "total": 20000,
      "finishings": [
        { "name": "Test 1", "price": 1000 },
        { "name": "Laminating", "price": 2000 }
      ]
    },
    {
      "name": "STICKER METALIC - GOLD",
      "quantity": 2,
      "price": 10000,
      "total": 20000,
      "finishings": [
        { "name": "Cutting", "price": 500 }
      ]
    }
  ],
  "subtotal": 43500,
  "ppnAmount": 4350,
  "discountAmount": 5000,
  "totalAmount": 42850,
  "paymentMethod": "Cash",
  "cashReceived": 50000,
  "cashChange": 7150,
  "paymentDate": "2024-12-04 14:30:00"
}
```

## Cara Penggunaan

### 1. Via GET Request dengan URL Parameter
```
http://localhost:5000/print/receipt?data={URL_ENCODED_JSON}
```

### 2. Via JavaScript Test Script
```bash
node test_print_with_finishing.js
```

### 3. Via Browser
Buka file `test_url_examples.txt` dan copy URL lengkap ke browser.

## Implementasi di Kode (index.js)

### Fungsi createReceiptText (baris 259-397)

**Bagian Finishing (baris 333-343):**
```javascript
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
```

**Bagian Diskon (baris 367-369):**
```javascript
if (discountAmount > 0) {
  receipt += formatLine("Diskon:", "-" + formatRupiah(discountAmount)) + commands.NEW_LINE;
}
```

## Fitur Lanjutan

### Finishing dengan Quantity
Finishing dapat memiliki quantity tersendiri:
```json
{
  "name": "Cutting",
  "price": 500,
  "quantity": 2
}
```

### Finishing yang Multiply dengan Quantity Item
```json
{
  "name": "Laminating per sheet",
  "price": 1000,
  "multiplyByQty": true
}
```
Jika item quantity = 10, maka finishing akan dikalikan 10 juga.

## Format Output

### Layout: 32 karakter (untuk thermal printer 58mm)
- Kolom kiri: Nama item/label
- Kolom kanan: Harga (align right)
- Indent finishing: 4 spasi + tanda "+"
- Indent quantity: 2 spasi

### Format Rupiah
- Separator ribuan: titik (.)
- Prefix: "Rp"
- Tanpa desimal
- Contoh: `Rp 1.000`, `Rp 50.000`

## Testing

### 1. Test Preview (tanpa print fisik)
```bash
node test_receipt_with_finishing.js
```

### 2. Test Print Fisik
```bash
# Pastikan server running
node index.js

# Di terminal baru
node test_print_with_finishing.js
```

### 3. Test via URL Browser
Gunakan URL dari file `test_url_examples.txt`

## Troubleshooting

### Finishing tidak muncul
- ✅ Pastikan property `finishings` adalah array
- ✅ Pastikan setiap finishing punya `name` dan `price`
- ✅ Cek console.log untuk error parsing

### Diskon tidak muncul
- ✅ Pastikan `discountAmount` > 0
- ✅ Cek `totalAmount` sudah dikurangi diskon

### Format tidak rapi
- ✅ Pastikan nama item/finishing tidak lebih dari 24-28 karakter
- ✅ Gunakan function `cleanText()` untuk remove karakter khusus

## Contoh Output Lengkap

```
================================
     Printing Express
Jl. Eastern Boulevard, Sampora,
Kec. Cisauk, Kabupaten
Tangerang, Banten 15345
Tel: 626262626212
================================

Tanggal: 2024-12-04 14:30:00
No. Struk: RCP-PIO-20251204-716289-7X7XGC
No. Order: PTI/ODR/2511/00046
Customer: Wartini
Telp: 132123123
--------------------------------
Item                  Qty  Harga
--------------------------------
FLEXY 340GR (HIGH RES)
  1 x Rp 20.000        Rp 20.000
    + Test 1            Rp 1.000
    + Laminating        Rp 2.000
  Subtotal item:       Rp 23.000
STICKER METALIC - GOLD
  2 x Rp 10.000        Rp 20.000
    + Cutting             Rp 500
  Subtotal item:       Rp 20.500
--------------------------------
Subtotal:              Rp 43.500
PPN:                    Rp 4.350
Diskon:                -Rp 5.000
TOTAL:                 Rp 42.850
Metode:                     Cash
Bayar:                 Rp 50.000
Kembali:                Rp 7.150

        Terima Kasih!
   Selamat Berbelanja Kembali
```

## File Terkait

- `index.js` - Main server file dengan implementasi
- `test_receipt_with_finishing.js` - Preview struk di console
- `test_print_with_finishing.js` - Test print via API
- `test_url_examples.txt` - Contoh URL lengkap untuk browser
- `README_FINISHING_DISKON.md` - Dokumentasi ini

---
**Last Updated:** 2024-12-05
**Version:** 1.0
