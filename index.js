import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import crypto from "crypto";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();

// ======================
// CONFIG
// ======================
const PORT = process.env.PORT || 3000;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_TOKEN = process.env.RELOADLY_TOKEN;

// IMPORTANT: body raw pour HMAC
app.use(
bodyParser.json({
verify: (req, res, buf) => {
req.rawBody = buf;
},
})
);

// ======================
// SQLITE (ANTI-DOUBLON PERSISTANT)
// ======================
const db = await open({
filename: "./topup.db",
driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS processed (
unique_key TEXT PRIMARY KEY,
status TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

async function alreadyProcessed(key) {
const row = await db.get(
"SELECT status FROM processed WHERE unique_key = ?",
key
);
return !!row; // bloque si PROCESSING ou DONE
}

async function lockBeforeSend(key) {
await db.run(
"INSERT OR IGNORE INTO processed (unique_key, status) VALUES (?, ?)",
key,
"PROCESSING"
);
}

async function markDone(key) {
await db.run(
"UPDATE processed SET status = 'DONE' WHERE unique_key = ?",
key
);
}

// ======================
// UTILS
// ======================
function cleanPhone(phone) {
return phone.replace(/\D/g, "");
}

function verifyShopifyHmac(req) {
const hmacHeader = req.headers["x-shopify-hmac-sha256"];
if (!hmacHeader) return false;

const digest = crypto
.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
.update(req.rawBody, "utf8")
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(digest),
Buffer.from(hmacHeader)
);
}

// ======================
// HEALTH CHECK
// ======================
app.get("/", (req, res) => {
res.send("✅ Wimas Webhook actif");
});

// ======================
// WEBHOOK SHOPIFY — ORDER PAID
// ======================
app.post("/webhook/paid", async (req, res) => {
try {
// 🔐 Vérification HMAC
if (!verifyShopifyHmac(req)) {
console.log("⛔ HMAC invalide");
return res.sendStatus(401);
}

const data = req.body;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);

// ======================
// 1️⃣ PRODUIT RECHARGE UNIQUEMENT (TAG = RECHARGE)
// ======================
let rechargeItem = null;

for (const item of data.line_items || []) {
const tags = (item.tags || "")
.toLowerCase()
.split(",")
.map((t) => t.trim());

if (tags.includes("recharge")) {
rechargeItem = item;
break;
}
}

if (!rechargeItem) {
console.log("⛔ Aucun produit RECHARGE → STOP");
return res.sendStatus(200);
}

console.log("💳 Produit RECHARGE:", rechargeItem.title);

// ======================
// 2️⃣ MONTANT RECHARGE (SEUL)
// ======================
const topupAmount =
parseFloat(rechargeItem.price) * rechargeItem.quantity;

if (!topupAmount || topupAmount <= 0) {
console.log("⛔ Montant invalide → STOP");
return res.sendStatus(200);
}

console.log("💰 Montant:", topupAmount);

// ======================
// 3️⃣ NUMÉRO TÉLÉPHONE
// ======================
const rawPhone =
data.note_attributes?.find((n) => n.name === "phone")?.value ||
data.phone;

if (!rawPhone) {
console.log("⛔ Numéro absent → STOP");
return res.sendStatus(200);
}

const phone = cleanPhone(rawPhone);
console.log("📞 Téléphone:", phone);

// ======================
// 4️⃣ CLÉ ANTI-DOUBLON FORTE
// ======================
const uniqueKey = `${data.id}-${phone}-${topupAmount}`;
console.log("🔑 Clé:", uniqueKey);

if (await alreadyProcessed(uniqueKey)) {
console.log("⛔ Déjà traité → STOP");
return res.sendStatus(200);
}

// 🔒 LOCK AVANT ARGENT
await lockBeforeSend(uniqueKey);
console.log("🧱 Clé verrouillée");

// ======================
// 5️⃣ AUTO-DETECT OPÉRATEUR (HT)
// ======================
const detectUrl = `https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/HT`;

const detect = await axios.get(detectUrl, {
headers: {
Authorization: `Bearer ${RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
},
});

const operatorId = detect.data?.operatorId;
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
Authorization: `Bearer ${RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json",
},
}
);

await markDone(uniqueKey);
console.log("🎉 Recharge envoyée avec succès");

return res.sendStatus(200);
} catch (err) {
console.error("❌ Erreur:", err.response?.data || err.message);
// On répond 200 pour éviter retry Shopify
return res.sendStatus(200);
}
});

// ======================
app.listen(PORT, () => {
console.log(`🚀 Wimas Webhook en ligne sur le port ${PORT}`);
});
