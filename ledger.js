/* Pure credit-ledger logic, kept dependency-free so it can be unit-tested
   on its own (no express / razorpay needed) and reused by server.js. */
const fs = require('fs');

function makeLedger(dbPath) {
  function readDb() { try { return JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (e) { return {}; } }
  function writeDb(db) { fs.writeFileSync(dbPath, JSON.stringify(db, null, 2)); }
  function getBalance(deviceId) { const db = readDb(); return (db[deviceId] || { credits: 0 }).credits; }
  function addCredits(deviceId, n, note) {
    const db = readDb(); db[deviceId] = db[deviceId] || { credits: 0, history: [] };
    db[deviceId].credits += n; db[deviceId].history.push({ t: Date.now(), n, note });
    writeDb(db); return db[deviceId].credits;
  }
  function spendCredit(deviceId) {
    const db = readDb(); const row = db[deviceId];
    if (!row || row.credits < 1) return null;
    row.credits -= 1; row.history.push({ t: Date.now(), n: -1, note: 'reunion photo' });
    writeDb(db); return row.credits;
  }
  return { getBalance, addCredits, spendCredit, readDb, writeDb };
}

const crypto = require('crypto');
function verifyRazorpaySignature(secret, orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex');
  // constant-time compare so a timing attack can't be used to guess the signature
  const a = Buffer.from(expected), b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { makeLedger, verifyRazorpaySignature };
