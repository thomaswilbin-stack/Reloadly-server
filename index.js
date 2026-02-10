import express from "express";
import crypto from "crypto";
import axios from "axios";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();

/* =========================
CONFIG
========================= */
const PORT = process.env.PORT || 10000;
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;

const RELOADLY_BASE_URL = "https://topups.reloadly.com";

/* =========================
SQLITE (ANTI-DOUBLON PERSISTANT)
========================= */
const db = await open({
filename: "./recharges.db", // ⚠️ sur Render → /data/recharges.db
driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS processed_orders (
id INTEGER PRIMARY KEY AUTOINCREMENT,
unique_key TEXT UNIQUE,
phone TEXT,
status TEXT DEFAULT 'LOCKED',
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

async function isProcessed(key) {
const row = await db.get(
"SELECT status FROM processed_orders WHERE unique_key = ?",
key
);
return row && (row.status === "LOCKED" || row.status === "SUCCESS");
}

async function lockOrder(key, phone) {
await db.run(
"INSERT OR IGNORE INTO processed_orders (unique_key, phone, status) VALUES (?, ?, 'LOCKED')",
key,
phone
);
}

async function markSuccess(key) {
await db.run(
"UPDATE processed_orders SET status = 'SUCCESS' WHERE unique_key = ?",
key
);
}

async function markFailed(key) {
await db.run(
"UPDATE processed_orders SET status = 'FAILED' WHERE unique_key = ?",
key
);
}

/* =========================
WEBHOOK SHOPIFY PAYÉ
========================= */
app.post(
"/webhook",
express.raw({ type: "application/json" }),
async (req, res) => {
let uniqueKey = null;

try {
/* ===== Vérification HMAC ===== */
const hmac = req.headers["x-shopify-hmac-sha256"];
const body = req.body.toString("utf8");

const generated = crypto
.createHmac("sha256", SHOPIFY_SECRET)
.update(body)
.digest("base64");

if (generated !== hmac) {
console.log("❌ HMAC invalide");
return res.status(401).send("Unauthorized");
}

const data = JSON.parse(body);

uniqueKey = data.checkout_id || data.id;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

/* ===== ANTI-DOUBLON ===== */
if (await isProcessed(uniqueKey)) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}

/* =========================
NUMÉRO
========================= */
let phone = null;

for (const item of data.line_items || []) {
for (const prop of item.properties || []) {
const key = (prop.name || "")
.toLowerCase()
.normalize("NFD")
.replace(/[\u0300-\u036f]/g, "");

if (
key.includes("numero") ||
key.includes("phone") ||
key.includes("telephone")
) {
if (prop.value && prop.value.trim()) {
phone = prop.value.trim();
break;
}
}
}
if (phone) break;
}

const cleanPhone = phone?.replace(/\D/g, "");
console.log("📞 Numéro nettoyé:", cleanPhone);

if (!cleanPhone || !cleanPhone.startsWith("509") || cleanPhone.length !== 11) {
console.log("❌ Numéro invalide");
return res.status(200).send("Invalid phone");
}

/* =========================
LIMITE / JOUR / NUMÉRO
========================= */
const todayCount = await db.get(
`
SELECT COUNT(*) as count
FROM processed_orders
WHERE phone = ?
AND DATE(created_at) = DATE('now')
`,
cleanPhone
);

if (todayCount.count >= 2) {
console.log("🚫 Limite journalière atteinte");
return res.status(200).send("Limit reached");
}

/* =========================
PRODUIT RECHARGE UNIQUEMENT
========================= */
let topupAmount = null;
let topupItem = null;

for (const item of data.line_items || []) {
const title = (item.title || "").toLowerCase().trim();
if (title === "recharge" || title.includes("recharge")) {
topupAmount = Number(item.price);
topupItem = item;
break;
}
}

console.log("💳 Produit TOP-UP:", topupItem?.title);
console.log("💰 Montant TOP-UP détecté:", topupAmount);

if (!topupAmount || topupAmount <= 0) {
console.log("❌ Aucun produit RECHARGE détecté");
return res.status(200).send("No recharge product");
}

/* =========================
🔒 LOCK AVANT ARGENT
========================= */
await lockOrder(uniqueKey, cleanPhone);
console.log("🧱 Clé verrouillée AVANT recharge");

/* =========================
AUTH RELOADLY
========================= */
const auth = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: RELOADLY_BASE_URL,
},
{ timeout: 7000 }
);

const token = auth.data.access_token;

/* =========================
AUTO-DETECT
========================= */
const detect = await axios.get(
`${RELOADLY_BASE_URL}/operators/auto-detect/phone/${cleanPhone}/countries/HT`,
{
timeout: 7000,
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const operatorId = detect.data.operatorId;
const operatorName = detect.data.name;

console.log("📡 Opérateur détecté:", operatorName);

/* =========================
RECHARGE
========================= */
const topup = await axios.post(
`${RELOADLY_BASE_URL}/topups`,
{
operatorId,
amount: topupAmount,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: cleanPhone,
},
customIdentifier: uniqueKey,
},
{
timeout: 10000,
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", topup.data.transactionId);

await markSuccess(uniqueKey);

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur recharge:", err.response?.data || err.message);
if (uniqueKey) await markFailed(uniqueKey);
return res.status(200).send("Handled");
}
}
);

/* =========================
HEALTH CHECK
========================= */
app.get("/", (req, res) => {
res.send("Reloadly server running");
});

/* =========================
START
========================= */
app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
