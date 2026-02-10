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
filename: "./recharges.db",
driver: sqlite3.Database,
});

await db.exec(`
CREATE TABLE IF NOT EXISTS processed_orders (
id INTEGER PRIMARY KEY AUTOINCREMENT,
unique_key TEXT UNIQUE,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

async function isProcessed(key) {
const row = await db.get(
"SELECT 1 FROM processed_orders WHERE unique_key = ?",
key
);
return !!row;
}

async function saveProcessed(key) {
await db.run(
"INSERT OR IGNORE INTO processed_orders (unique_key) VALUES (?)",
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

const uniqueKey = data.checkout_id || data.id;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

/* ===== ANTI-DOUBLON BÉTON ===== */
if (await isProcessed(uniqueKey)) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}

/* =========================
NUMÉRO (CHAMP PRODUIT)
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

/* =========================
PRODUIT RECHARGE UNIQUEMENT
========================= */
let topupAmount = null;
let topupItem = null;

for (const item of data.line_items || []) {
const title = (item.title || "")
.toLowerCase()
.trim();

// 🔒 RÈGLE BÉTON : TITRE = RECHARGE
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
FORMAT NUMÉRO (OBLIGATOIRE)
========================= */
const cleanPhone = phone.replace(/\D/g, "");

console.log("📞 Numéro nettoyé:", cleanPhone);

if (!cleanPhone.startsWith("509") || cleanPhone.length !== 11) {
console.log("❌ Numéro invalide:", cleanPhone);
return res.status(200).send("Invalid phone");
}

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
}
);

const token = auth.data.access_token;

let operatorId;
let operatorName = "UNKNOWN";

/* =========================
AUTO-DETECT AVEC FALLBACK
========================= */
try {
console.log("🔎 Auto-detect:", `${RELOADLY_BASE_URL}/operators/auto-detect/phone/${cleanPhone}/countries/HT`);

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

operatorId = detect.data.operatorId;
operatorName = detect.data.name;
console.log("📡 Opérateur détecté:", operatorName);

} catch (err) {
console.warn("⚠️ Auto-detect KO → fallback opérateur");

/* ===== FALLBACK LISTE OPÉRATEURS ===== */
const ops = await axios.get(
`${RELOADLY_BASE_URL}/operators/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const operators = ops.data.content || [];

const natcom = operators.find(o =>
o.name.toLowerCase().includes("natcom")
);
const digicel = operators.find(o =>
o.name.toLowerCase().includes("digicel")
);

const selected = natcom || digicel;

if (!selected) {
throw new Error("Aucun opérateur HT disponible");
}

operatorId = selected.id;
operatorName = selected.name;

console.log("🛟 Fallback opérateur utilisé:", operatorName);
}

  /* =========================
🔒 BLOCAGE AVANT RECHARGE
========================= */
await lockKey(uniqueKey);
console.log("🧱 Clé verrouillée AVANT recharge");

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
headers: { Authorization: `Bearer ${token}` },
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", topup.data.transactionId);

/* ===== SAUVEGARDE SQLITE ===== */
console.log("💾 Recharge sauvegardée (SQLite)");

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur recharge:", err.response?.data || err.message);
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






