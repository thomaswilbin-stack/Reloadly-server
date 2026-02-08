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
WEBHOOK SHOPIFY PAYÉ
========================= */
app.post(
"/webhook",
express.raw({ type: "application/json" }),
async (req, res) => {
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

if (data.financial_status !== "paid") {
console.log("⛔ Commande non payée");
return res.status(200).send("Not paid");
}

/* =========================
CLÉ ANTI-DOUBLON
========================= */
const uniqueKey = data.checkout_id || data.id;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

const exists = await db.get(
"SELECT 1 FROM processed_orders WHERE unique_key = ?",
uniqueKey
);

if (exists) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}

/* =========================
DÉTECTION NUMÉRO (BLINDÉE)
========================= */
let phone = null;

// 1️⃣ line_items.properties
for (const item of data.line_items || []) {
for (const prop of item.properties || []) {
const key = (prop.name || "")
.toLowerCase()
.normalize("NFD")
.replace(/[\u0300-\u036f]/g, "");

if (
key.includes("phone") ||
key.includes("numero") ||
key.includes("telephone")
) {
if (prop.value?.trim()) {
phone = prop.value.trim();
break;
}
}
}
if (phone) break;
}

// 2️⃣ note_attributes
if (!phone && Array.isArray(data.note_attributes)) {
for (const n of data.note_attributes) {
const key = (n.name || "").toLowerCase();
if (key.includes("phone") || key.includes("numero")) {
phone = n.value?.trim();
break;
}
}
}

// 3️⃣ shipping address
if (!phone && data.shipping_address?.phone) {
phone = data.shipping_address.phone.trim();
}

// 4️⃣ billing address
if (!phone && data.billing_address?.phone) {
phone = data.billing_address.phone.trim();
}

// 5️⃣ customer
if (!phone && data.customer?.phone) {
phone = data.customer.phone.trim();
}

/* =========================
MONTANT
========================= */
const amount = Number(data.current_total_price);

console.log("📱 Numéro détecté FINAL:", phone);
console.log("💰 Montant détecté:", amount);

if (!phone || !amount || amount <= 0) {
console.log("❌ Données manquantes");
return res.status(200).send("Missing data");
}

const cleanPhone = phone.replace(/\D/g, "");
if (!cleanPhone.startsWith("509") || cleanPhone.length !== 11) {
console.log("❌ Numéro invalide:", cleanPhone);
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
AUTO-DETECT OPÉRATEUR
========================= */
const detect = await axios.get(
`${RELOADLY_BASE_URL}/operators/auto-detect/phone/${cleanPhone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const operatorId = detect.data.operatorId;
console.log("📡 Opérateur détecté:", detect.data.name);

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
{
headers: { Authorization: `Bearer ${token}` },
}
);

/* =========================
SAUVEGARDE SQLITE
========================= */
await db.run(
"INSERT INTO processed_orders (unique_key, order_id) VALUES (?, ?)",
uniqueKey,
data.id
);

console.log("🎉 RECHARGE RÉUSSIE + SAUVEGARDÉE");

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur:", err.response?.data || err.message);
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


