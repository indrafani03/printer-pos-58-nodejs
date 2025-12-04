// Test script untuk melihat output struk dengan finishing dan diskon
const receiptData = {
  store: {
    name: "Printing Express",
    address: "Jl. Eastern Boulevard, Sampora, Kec. Cisauk, Kabupaten Tangerang, Banten 15345",
    phone: "626262626212"
  },
  receiptNumber: "RCP-PIO-20251204-716289-7X7XGC",
  orderNumber: "PTI/ODR/2511/00046",
  customerName: "Wartini",
  customerPhone: "132123123",
  items: [
    {
      name: "FLEXY 340GR (HIGH RES)",
      quantity: 1,
      price: 20000,
      total: 20000,
      finishings: [
        { name: "Test 1", price: 1000 },
        { name: "Laminating", price: 2000 }
      ]
    },
    {
      name: "STICKER METALIC - GOLD",
      quantity: 2,
      price: 10000,
      total: 20000,
      finishings: [
        { name: "Cutting", price: 500 }
      ]
    }
  ],
  subtotal: 43500,
  ppnAmount: 4350,
  discountAmount: 5000,
  totalAmount: 42850,
  paymentMethod: "Cash",
  cashReceived: 50000,
  cashChange: 7150,
  paymentDate: "2024-12-04 14:30:00"
};

// Format helper functions
function formatLine(left, right = '', width = 32) {
  const leftStr = left.toString().substring(0, width - right.length);
  const rightStr = right.toString();
  const spaces = ' '.repeat(Math.max(0, width - leftStr.length - rightStr.length));
  return leftStr + spaces + rightStr;
}

function cleanText(text) {
  return text
    .replace(/[^\x20-\x7E\n\r]/g, '')
    .replace(/[\x00-\x1F]/g, '')
    .trim();
}

function formatRupiah(amount) {
  const formatted = new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0
  }).format(amount).replace('IDR', 'Rp');
  return cleanText(formatted);
}

console.log("================================");
console.log("     Printing Express");
console.log("Jl. Eastern Boulevard, Sampora,");
console.log("Kec. Cisauk, Kabupaten");
console.log("Tangerang, Banten 15345");
console.log("Tel: 626262626212");
console.log("================================");
console.log("");
console.log("Tanggal: 2024-12-04 14:30:00");
console.log("No. Struk: RCP-PIO-20251204-716289-7X7XGC");
console.log("No. Order: PTI/ODR/2511/00046");
console.log("Customer: Wartini");
console.log("Telp: 132123123");
console.log("--------------------------------");
console.log(formatLine("Item", "Qty  Harga"));
console.log("--------------------------------");

// Item 1
console.log("FLEXY 340GR (HIGH RES)");
console.log(formatLine("  1 x Rp 20.000", "Rp 20.000"));
console.log(formatLine("    + Test 1", "Rp 1.000"));
console.log(formatLine("    + Laminating", "Rp 2.000"));
console.log(formatLine("  Subtotal item:", "Rp 23.000"));

// Item 2
console.log("STICKER METALIC - GOLD");
console.log(formatLine("  2 x Rp 10.000", "Rp 20.000"));
console.log(formatLine("    + Cutting", "Rp 500"));
console.log(formatLine("  Subtotal item:", "Rp 20.500"));

console.log("--------------------------------");
console.log(formatLine("Subtotal:", "Rp 43.500"));
console.log(formatLine("PPN:", "Rp 4.350"));
console.log(formatLine("Diskon:", "-Rp 5.000"));
console.log("**" + formatLine("TOTAL:", "Rp 42.850") + "**");
console.log(formatLine("Metode:", "Cash"));
console.log(formatLine("Bayar:", "Rp 50.000"));
console.log(formatLine("Kembali:", "Rp 7.150"));
console.log("");
console.log("        Terima Kasih!");
console.log("   Selamat Berbelanja Kembali");
console.log("");
console.log("================================");
