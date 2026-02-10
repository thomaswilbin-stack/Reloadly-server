import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import crypto from "crypto";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

console.log("🔥 FICHIER index.js CHARGÉ");

const app = express();

/* ======================
CONFIG
====================== */
const PORT = process.env.PORT || 3000;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_TOKEN = process.env.RELOADLY_TOKEN;

/* ======================
RAW BODY POUR HMAC
====================== */
app.use(
bodyParser.json({
verify: (req, res, buf) => {
req.rawBody = buf;
},
})
);

/* ======================
SQLITE (ANTI-DOUBLON)
====================== */
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
return !!row;
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

/* ======================
UTILS
====================== */
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

/* ======================
HEALTH CHECK
====================== */
app.get("/", (req, res) => {
console.log("🟢 GET / touché");
res.send("✅ Wimas Webhook actif");
});

/* ======================
DEBUG — CONFIRME QUE SHOPIFY TOUCHE LA ROUTE
====================== */
app.post("/webhook/paid", (req, res, next) => {
console.log("🔥 WEBHOOK /webhook/paid TOUCHÉ");
next();
});

/* ======================
WEBHOOK SHOPIFY — ORDER PAID
====================== */
app.post("/webhook/paid", async (req, res) => {
try {
/* ===== HMAC ===== */
if (!verifyShopifyHmac(req)) {
console.log("⛔ HMAC invalide");
return res.sendStatus(401);
}

const data = req.body;

console.log("✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);

/* ======================
PRODUIT RECHARGE UNIQUEMENT (TAG = RECHARGE)
====================== */
let rechargeItem = null;

for (const item of data.line_items || []) {
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
console.log("⛔ Aucun produit RECHARGE → STOP");
return res.sendStatus(200);
}

console.log("💳 Produit RECHARGE:", rechargeItem.title);

/* ======================
MONTANT
====================== */
const amount = Number(rechargeItem.price) * rechargeItem.quantity;
console.log("💰 Montant:", amount);

if (!amount || amount <= 0) {
console.log("⛔ Montant invalide");
return res.sendStatus(200);
}

/* ======================
NUMÉRO
====================== */
const rawPhone =
data.note_attributes?.find(n => n.name === "phone")?.value ||
data.phone;

if (!rawPhone) {
console.log("⛔ Numéro absent");
return res.sendStatus(200);
}

const phone = cleanPhone(rawPhone);
console.log("📞 Téléphone:", phone);

/* ======================
CLÉ ANTI-DOUBLON
====================== */
const uniqueKey = `${data.id}-${phone}-${amount}`;
console.log("🔑 Clé:", uniqueKey);

if (await alreadyProcessed(uniqueKey)) {
console.log("🛑 Déjà traité → STOP");
return res.sendStatus(200);
}

await lockBeforeSend(uniqueKey);
console.log("🧱 Clé verrouillée AVANT recharge");

/* ======================
AUTO-DETECT OPÉRATEUR (HT)
====================== */
const detect = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const operatorId = detect.data?.operatorId;
console.log("📡 Operator ID:", operatorId);

if (!operatorId) {
console.log("⛔ Opérateur introuvable");
return res.sendStatus(200);
}

/* ======================
ENVOI RECHARGE
====================== */
await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: phone,
},
customIdentifier: uniqueKey,
},
{
headers: {
Authorization: `Bearer ${RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

await markDone(uniqueKey);
console.log("🎉 RECHARGE RÉUSSIE");

return res.sendStatus(200);

} catch (err) {
console.error("❌ ERREUR:", err.response?.data || err.message);
return res.sendStatus(200);
}
});

/* ======================
START SERVER
====================== */
app.listen(PORT, () => {
console.log(`🚀 Wimas Webhook en ligne sur le port ${PORT}`);
});
