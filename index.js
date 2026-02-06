import express from "express";
import crypto from "crypto";
import axios from "axios";

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
ANTI-DOUBLON (RAM)
========================= */
const processedKeys = new Set();

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

/* ===== Clé anti-doublon ===== */
const uniqueKey =
data.checkout_id ||
data.id ||
`${data.id}-${data.created_at}`;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

if (processedKeys.has(uniqueKey)) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}
processedKeys.add(uniqueKey);

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
MONTANT (OFFICIEL)
========================= */
const amount =
Number(data.current_total_price) ||
Number(data.total_price) ||
Number(data.subtotal_price) ||
Number(data.line_items?.[0]?.price) ||
null;

console.log("📱 Numéro détecté:", phone);
console.log("💰 Montant détecté:", amount);

if (!phone || !amount || amount <= 0) {
console.log("❌ Données manquantes");
return res.status(200).send("Missing data");
}

/* ===== Format numéro ===== */
const cleanPhone = phone.replace(/\D/g, "");

if (!cleanPhone.startsWith("509") || cleanPhone.length !== 11) {
console.log("❌ Numéro invalide:", cleanPhone);
return res.status(200).send("Invalid phone");
}

/* ===== AUTH RELOADLY ===== */
async function getReloadlyToken() {
  if (reloadlyToken) return reloadlyToken;

  const audience =
 process.env.RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
 : "https://topups-sandbox.reloadly.com";

  const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
    {
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",audience

    },
  { headers: { "Content-Type": "application/json" } }
 );
reloadlyToken = res.data.access_token;
console.log("🔐 Reloadly authentifié");
return reloadlyToken;
}

/* ===== AUTO-DETECT OPÉRATEUR (ENDPOINT CORRECT) ===== */
const detectRes = await axios.get(
`${RELOADLY_BASE_URL}/operators/auto-detect/phone/${cleanPhone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const operatorId = detectRes.data.operatorId;
console.log("📡 Opérateur détecté:", detectRes.data.name);

/* =========================
RECHARGE
========================= */
const topup = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount: Number(amount),
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: cleanPhone,
},
customIdentifier: uniqueKey, // sécurité anti-duplication Reloadly
},
{
headers: { Authorization: `Bearer ${token}` },
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", topup.data.transactionId);

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur recharge:", err.response?.data || err.message);
// Toujours 200 pour éviter retry Shopify
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




