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
DATABASE SQLITE
========================= */
const db = await open({
filename: "./orders.db",
driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS processed_orders (
id INTEGER PRIMARY KEY AUTOINCREMENT,
unique_key TEXT UNIQUE,
order_id TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

/* =========================
WEBHOOK SHOPIFY
========================= */
app.post(
"/webhook",
express.raw({ type: "application/json" }),
async (req, res) => {
try {
/* ===== HMAC ===== */
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

if (data.financial_status !== "paid") {
console.log("⛔ Non payé");
return res.status(200).send("Not paid");
}

const uniqueKey = data.checkout_id || data.id;

console.log("\n✅ Webhook PAYÉ");
console.log("🔑 Clé:", uniqueKey);

/* =========================
ANTI-DOUBLON SQLITE
========================= */
const exists = await db.get(
"SELECT 1 FROM processed_orders WHERE unique_key = ?",
uniqueKey
);

if (exists) {
console.log("🛑 Déjà traité");
return res.status(200).send("Already processed");
}

/* =========================
NUMÉRO (champ produit)
========================= */
let phone = null;

for (const item of data.line_items || []) {
for (const prop of item.properties || []) {
const key = (prop.name || "").toLowerCase();
if (key.includes("phone") || key.includes("numero")) {
phone = prop.value?.trim();
break;
}
}
if (phone) break;
}

const amount = Number(data.current_total_price);

if (!phone || !amount) {
console.log("❌ Données manquantes");
return res.status(200).send("Missing data");
}

const cleanPhone = phone.replace(/\D/g, "");
if (!cleanPhone.startsWith("509")) {
console.log("❌ Numéro invalide");
return res.status(200).send("Invalid phone");
}

/* =========================
TOKEN RELOADLY
========================= */
const auth = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: RELOADLY_BASE_URL,
}
);

const token = auth.data.access_token;

/* =========================
OPÉRATEUR AUTO-DETECT
========================= */
const detect = await axios.get(
`${RELOADLY_BASE_URL}/operators/auto-detect/phone/${cleanPhone}?countryCode=HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const operatorId = detect.data.operatorId;

/* =========================
RECHARGE
========================= */
await axios.post(
`${RELOADLY_BASE_URL}/topups`,
{
operatorId,
amount,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: cleanPhone,
},
customIdentifier: uniqueKey,
},
{ headers: { Authorization: `Bearer ${token}` } }
);

/* =========================
SAVE SQLITE (FINAL)
========================= */
await db.run(
"INSERT INTO processed_orders (unique_key, order_id) VALUES (?, ?)",
uniqueKey,
data.id
);

console.log("🎉 Recharge OK + sauvegardée");

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur:", err.response?.data || err.message);
return res.status(200).send("Handled");
}
}
);

/* =========================
START
========================= */
app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
