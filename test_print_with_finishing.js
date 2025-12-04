// Test script untuk print receipt dengan finishing dan diskon via API
const http = require('http');

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

// Encode data as URL query parameter
const encodedData = encodeURIComponent(JSON.stringify(receiptData));
const url = `http://localhost:5000/print/receipt?data=${encodedData}`;

console.log('🖨️  Testing print with finishing and discount...\n');
console.log('📋 Receipt Data:');
console.log(JSON.stringify(receiptData, null, 2));
console.log('\n📡 Sending request to:', url.substring(0, 100) + '...');
console.log('\n⏳ Waiting for response...\n');

http.get(url, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('✅ Print request successful!');
      console.log('\n📄 Check your printer for the receipt.');
      console.log('\nReceipt should show:');
      console.log('  - 2 items with their finishings');
      console.log('  - Item 1: FLEXY 340GR with 2 finishings (Test 1, Laminating)');
      console.log('  - Item 2: STICKER METALIC with 1 finishing (Cutting)');
      console.log('  - Subtotal: Rp 43.500');
      console.log('  - PPN: Rp 4.350');
      console.log('  - Diskon: -Rp 5.000');
      console.log('  - Total: Rp 42.850');
    } else {
      console.log('❌ Print request failed!');
      console.log('Status code:', res.statusCode);
      console.log('Response:', data);
    }
  });
}).on('error', (err) => {
  console.error('❌ Error:', err.message);
  console.log('\n💡 Make sure the server is running: node index.js');
});
