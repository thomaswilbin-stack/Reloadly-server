import express from "express";
import crypto from "crypto";
import axios from "axios";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const app = express();

/* ======================
CONFIG
====================== */
const PORT = process.env.PORT || 3000;
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_BASE = "https://topups.reloadly.com";

/* ======================
RAW BODY (HMAC)
====================== */
app.use(
express.raw({
type: "application/json",
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
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

async function alreadyProcessed(key) {
return !!(await db.get(
"SELECT 1 FROM processed WHERE unique_key = ?",
key
));
}

async function lockBeforeSend(key) {
await db.run(
"INSERT OR IGNORE INTO processed (unique_key) VALUES (?)",
key
);
}

/* ======================
UTILS
====================== */
const cleanPhone = (p) => p.replace(/\D/g, "");

/* ======================
WEBHOOK SHOPIFY PAYÉ
====================== */
app.post("/webhook/paid", async (req, res) => {
try {
/* ===== HMAC CHECK ===== */
const hmac = req.headers["x-shopify-hmac-sha256"];
const body = req.body.toString("utf8");

const digest = crypto
.createHmac("sha256", SHOPIFY_SECRET)
.update(body)
.digest("base64");

if (digest !== hmac) {
console.log("❌ HMAC invalide");
return res.status(401).send("Unauthorized");
}

const data = JSON.parse(body);

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);

/* ======================
PRODUIT RECHARGE UNIQUEMENT
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

const amount = Number(rechargeItem.price) * rechargeItem.quantity;
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
if (!phone.startsWith("509") || phone.length !== 11) {
console.log("⛔ Numéro invalide:", phone);
return res.sendStatus(200);
}

/* ======================
CLÉ ANTI-DOUBLON FORTE
====================== */
const uniqueKey = `${data.id}-${phone}-${amount}`;

if (await alreadyProcessed(uniqueKey)) {
console.log("🛑 Déjà traité → STOP");
return res.sendStatus(200);
}

await lockBeforeSend(uniqueKey);
console.log("🧱 Clé verrouillée AVANT recharge");

/* ======================
AUTH RELOADLY
====================== */
const auth = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: RELOADLY_BASE,
}
);

const token = auth.data.access_token;

/* ======================
AUTO-DETECT + FALLBACK
====================== */
let operatorId;

try {
const detect = await axios.get(
`${RELOADLY_BASE}/operators/auto-detect/phone/${phone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);
operatorId = detect.data.operatorId;
} catch {
const ops = await axios.get(
`${RELOADLY_BASE}/operators/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const op =
ops.data.content.find(o => o.name.toLowerCase().includes("natcom")) ||
ops.data.content.find(o => o.name.toLowerCase().includes("digicel"));

if (!op) throw new Error("Opérateur HT introuvable");
operatorId = op.id;
}

/* ======================
RECHARGE
====================== */
await axios.post(
`${RELOADLY_BASE}/topups`,
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
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

console.log("🎉 Recharge réussie");
return res.sendStatus(200);

} catch (err) {
console.error("❌ Erreur:", err.response?.data || err.message);
return res.sendStatus(200);
}
});

/* ======================
START
====================== */
app.listen(PORT, () => {
console.log(`🚀 Webhook actif sur le port ${PORT}`);
});
