import express from "express";
import crypto from "crypto";
import axios from "axios";
import fs from "fs";

const app = express();

/* =========================
CONFIG
========================= */
const PORT = process.env.PORT || 10000;
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_ENV = process.env.RELOADLY_ENV || "production";

const RELOADLY_BASE_URL =
RELOADLY_ENV === "sandbox"
? "https://topups-sandbox.reloadly.com"
: "https://topups.reloadly.com";

/* =========================
ANTI-DOUBLON PERSISTANT (FICHIER)
========================= */
const DB_FILE = "./processed.json";
let processed = new Set();

if (fs.existsSync(DB_FILE)) {
processed = new Set(JSON.parse(fs.readFileSync(DB_FILE)));
}

function saveProcessed() {
fs.writeFileSync(DB_FILE, JSON.stringify([...processed]));
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

/* ===== Sécurité statut ===== */
if (data.financial_status !== "paid") {
console.log("⛔ Commande non payée → ignorée");
return res.status(200).send("Not paid");
}

/* ===== Clé anti-doublon UNIQUE ===== */
const uniqueKey =
data.checkout_id || data.id || `${data.id}-${data.created_at}`;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

if (processed.has(uniqueKey)) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}

/* =========================
NUMÉRO (champ produit obligatoire)
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
if (prop.value?.trim()) {
phone = prop.value.trim();
break;
}
}
}
if (phone) break;
}

const amount = Number(data.current_total_price);

console.log("📱 Numéro détecté:", phone);
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
SÉCURITÉ RELOADLY (ANTI-DUP FINAL)
========================= */
const check = await axios.get(`${RELOADLY_BASE_URL}/topups`, {
headers: { Authorization: `Bearer ${token}` },
params: { customIdentifier: uniqueKey },
});

if (Array.isArray(check.data) && check.data.length > 0) {
console.log("🛑 Recharge déjà faite chez Reloadly → STOP");
processed.add(uniqueKey);
saveProcessed();
return res.status(200).send("Already topped up");
}

/* =========================
AUTO-DETECT OPÉRATEUR
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
console.log("📡 Opérateur:", detect.data.name);

/* =========================
RECHARGE
========================= */
const topup = await axios.post(
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

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", topup.data.transactionId);

processed.add(uniqueKey);
saveProcessed();

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
