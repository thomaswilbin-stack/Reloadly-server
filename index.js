import express from "express";
import crypto from "crypto";
import axios from "axios";
import Database from "better-sqlite3";

const app = express();

/* =========================
CONFIG
========================= */
const PORT = process.env.PORT || 10000;
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_ENV = process.env.RELOADLY_ENV || "production";

/* =========================
BASE URL RELOADLY
========================= */
const RELOADLY_BASE_URL =
RELOADLY_ENV === "sandbox"
? "https://topups-sandbox.reloadly.com"
: "https://topups.reloadly.com";

/* =========================
SQLITE — ANTI-DOUBLON PERSISTANT
========================= */
const db = new Database("anti-doublon.db");

db.prepare(`
CREATE TABLE IF NOT EXISTS processed_orders (
id TEXT PRIMARY KEY,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`).run();

/* =========================
WEBHOOK SHOPIFY PAYÉ
========================= */
app.post(
"/webhook",
express.raw({ type: "application/json" }),
async (req, res) => {
try {
/* ===== Vérification HMAC Shopify ===== */
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

/* ===== Clé anti-doublon persistante ===== */
const uniqueKey = data.checkout_id || data.id;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

const alreadyProcessed = db
.prepare("SELECT id FROM processed_orders WHERE id = ?")
.get(uniqueKey);

if (alreadyProcessed) {
console.log("🛑 Doublon PERSISTANT détecté → ignoré");
return res.status(200).send("Already processed");
}

/* =========================
NUMÉRO (CHAMP PRODUIT)
========================= */
let phone = null;

if (Array.isArray(data.line_items)) {
for (const item of data.line_items) {
if (!Array.isArray(item.properties)) continue;

for (const prop of item.properties) {
const key = (prop.name || "")
.toLowerCase()
.normalize("NFD")
.replace(/[\u0300-\u036f]/g, "");

if (
key.includes("numero") ||
key.includes("phone") ||
key.includes("telephone")
) {
if (prop.value && prop.value.trim() !== "") {
phone = prop.value.trim();
break;
}
}
}
if (phone) break;
}
}

/* =========================
MONTANT
========================= */
const amount = Number(
data.current_total_price ||
data.total_price ||
data.subtotal_price
);

console.log("📱 Numéro détecté:", phone);
console.log("💰 Montant détecté:", amount);

if (!phone || !amount || amount <= 0) {
console.log("❌ Données manquantes");
return res.status(200).send("Missing data");
}

/* ===== Nettoyage numéro ===== */
const cleanPhone = phone.replace(/\D/g, "");

if (!cleanPhone.startsWith("509") || cleanPhone.length !== 11) {
console.log("❌ Numéro invalide:", cleanPhone);
return res.status(200).send("Invalid phone");
}

/* =========================
AUTH RELOADLY
========================= */
const authRes = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: RELOADLY_BASE_URL,
},
{ headers: { "Content-Type": "application/json" } }
);

const token = authRes.data.access_token;

/* =========================
AUTO-DETECT OPÉRATEUR (HT OK)
========================= */
const detectUrl =
`${RELOADLY_BASE_URL}` +
`/operators/auto-detect/phone/${cleanPhone}/countries/HT`;

console.log("🔎 URL AUTO-DETECT UTILISÉE:", detectUrl);

const detectRes = await axios.get(detectUrl, {
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
});

const operatorId = detectRes.data.operatorId;
console.log("📡 Opérateur détecté:", detectRes.data.name);

/* =========================
RECHARGE
========================= */
const topup = await axios.post(
`${RELOADLY_BASE_URL}/topups`,
{
operatorId,
amount: Number(amount),
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

/* ===== Enregistrement PERSISTANT ===== */
db.prepare("INSERT INTO processed_orders (id) VALUES (?)")
.run(uniqueKey);

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
console.log("🔥 VERSION INDEX FINALE — ANTI-DOUBLON PERSISTANT");
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
