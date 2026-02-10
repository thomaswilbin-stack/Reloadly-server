import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();
app.use(bodyParser.json());

// ======================
// SQLITE (ANTI-DOUBLON)
// ======================
const db = await open({
filename: "./topup.db",
driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS processed (
unique_key TEXT PRIMARY KEY,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

async function alreadyProcessed(key) {
const row = await db.get(
"SELECT unique_key FROM processed WHERE unique_key = ?",
key
);
return !!row;
}

async function lockBeforeSend(key) {
await db.run(
"INSERT OR IGNORE INTO processed (unique_key) VALUES (?)",
key
);
}

// ======================
// UTILS
// ======================
function cleanPhone(phone) {
return phone.replace(/\D/g, "");
}

// ======================
// WEBHOOK SHOPIFY
// ======================
app.post("/webhook/paid", async (req, res) => {
try {
const data = req.body;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);

// ======================
// 1️⃣ TROUVER PRODUIT RECHARGE UNIQUEMENT
// ======================
let rechargeItem = null;

for (const item of data.line_items) {
const tags = (item.tags || "")
.toLowerCase()
.split(",")
.map(t => t.trim());

if (tags.includes("recharge")) {
rechargeItem = item;
break;
}
}

if (!rechargeItem) {
console.log("⛔ Aucun produit RECHARGE détecté → STOP");
return res.sendStatus(200);
}

console.log("💳 Produit RECHARGE détecté :", rechargeItem.title);

// ======================
// 2️⃣ MONTANT RECHARGE (SEUL)
// ======================
const topupAmount =
parseFloat(rechargeItem.price) * rechargeItem.quantity;

if (!topupAmount || topupAmount <= 0) {
console.log("⛔ Montant invalide → STOP");
return res.sendStatus(200);
}

console.log("💰 Montant TOP-UP détecté:", topupAmount);

// ======================
// 3️⃣ TÉLÉPHONE
// ======================
const rawPhone =
data.note_attributes?.find((n) => n.name === "phone")?.value ||
data.phone;

if (!rawPhone) {
console.log("⛔ Numéro absent → STOP");
return res.sendStatus(200);
}

const phone = cleanPhone(rawPhone);
console.log("📞 Numéro nettoyé:", phone);

// ======================
// 4️⃣ CLÉ ANTI-DOUBLON FORTE
// ======================
const uniqueKey = `${data.id}-${phone}-${topupAmount}`;
console.log("🔑 Clé anti-doublon:", uniqueKey);

if (await alreadyProcessed(uniqueKey)) {
console.log("⛔ Recharge déjà traitée → STOP");
return res.sendStatus(200);
}

// 🔒 BLOCAGE AVANT ARGENT
await lockBeforeSend(uniqueKey);
console.log("🧱 Clé verrouillée AVANT recharge");

// ======================
// 5️⃣ AUTO-DETECT OPÉRATEUR
// ======================
const detectUrl = `https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/HT`;

const detect = await axios.get(detectUrl, {
headers: {
Authorization: `Bearer ${process.env.RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
},
});

const operatorId = detect.data.operatorId;

if (!operatorId) {
console.log("⛔ Opérateur introuvable → STOP");
return res.sendStatus(200);
}

console.log("📡 Operator ID:", operatorId);

// ======================
// 6️⃣ ENVOI RECHARGE
// ======================
await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount: topupAmount,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: phone,
},
},
{
headers: {
Authorization: `Bearer ${process.env.RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json",
},
}
);

console.log("🎉 Recharge envoyée avec succès");
return res.sendStatus(200);
} catch (err) {
console.error("❌ Erreur recharge:", err.response?.data || err.message);
return res.sendStatus(200);
}
});

// ======================
app.listen(3000, () => {
console.log("🚀 Webhook actif sur le port 3000");
});
