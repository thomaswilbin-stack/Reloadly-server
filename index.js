import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();
app.use(express.json());

// =====================
// 🔐 VERROU ANTI-DOUBLON (CRITIQUE)
// =====================
const processingLocks = new Set();

// =====================
// 🔑 VARIABLES ENV
// =====================
const {
SHOPIFY_WEBHOOK_SECRET,
RELOADLY_CLIENT_ID,
RELOADLY_CLIENT_SECRET,
PORT = 3000,
} = process.env;

// =====================
// 🔐 VÉRIFICATION SIGNATURE SHOPIFY
// =====================
function verifyShopifyWebhook(req) {
const hmac = req.headers["x-shopify-hmac-sha256"];
const body = JSON.stringify(req.body);

const hash = crypto
.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
.update(body)
.digest("base64");

return hash === hmac;
}

// =====================
// 🔑 AUTH RELOADLY
// =====================
let reloadlyToken = null;
let tokenExpiry = 0;

async function getReloadlyToken() {
if (reloadlyToken && Date.now() < tokenExpiry) return reloadlyToken;

const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com",
}
);

reloadlyToken = res.data.access_token;
tokenExpiry = Date.now() + res.data.expires_in * 1000 - 60000;
return reloadlyToken;
}

// =====================
// 📡 WEBHOOK SHOPIFY PAYÉ
// =====================
app.post("/webhook/shopify-paid", async (req, res) => {
try {
if (!verifyShopifyWebhook(req)) {
console.log("❌ Webhook Shopify invalide");
return res.status(401).send("Invalid webhook");
}

const order = req.body;
const checkoutId = order.checkout_id;

const lockKey = `checkout-${checkoutId}`;

// 🔒 VERROU GLOBAL
if (processingLocks.has(lockKey)) {
console.log("🔁 Webhook dupliqué bloqué AVANT recharge");
return res.status(200).send("Already processing");
}

processingLocks.add(lockKey);

console.log("\n✅ Webhook Shopify PAYÉ reçu");
console.log("🧾 Commande ID:", order.id);
console.log("🧩 Checkout ID:", checkoutId);

// 📱 NUMÉRO
const phone =
order.note_attributes?.find((n) =>
n.name.toLowerCase().includes("num")
)?.value || null;

if (!phone) {
console.log("❌ Numéro manquant");
processingLocks.delete(lockKey);
return res.status(200).send("No phone");
}

const amount = Number(order.line_items[0].price);

console.log("📱 Numéro reçu:", phone);
console.log("💰 Montant reçu:", amount);

// 🔑 TOKEN
const token = await getReloadlyToken();

// 📡 DÉTECTION OPÉRATEUR
const cleanPhone = phone.replace("+509", "");
const detect = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${cleanPhone}/countries/HT`,
{ headers: { Authorization: `Bearer ${token}` } }
);

const operatorId = detect.data.operatorId;
console.log("📡 Opérateur détecté:", detect.data.operatorName);

// 💳 RECHARGE
const topup = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: true,
recipientPhone: {
countryCode: "HT",
number: cleanPhone,
},
customIdentifier: checkoutId,
},
{ headers: { Authorization: `Bearer ${token}` } }
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", topup.data.transactionId);

processingLocks.delete(lockKey);
res.status(200).send("Recharge OK");
} catch (err) {
const code = err.response?.data?.errorCode;

if (code === "PHONE_RECENTLY_RECHARGED") {
console.log("🔒 Recharge déjà effectuée – bloquée proprement");
return res.status(200).send("Already recharged");
}

console.error("❌ Erreur recharge réelle:", err.response?.data || err.message);
res.status(200).send("Handled");
}
});

// =====================
app.get("/", (req, res) => {
res.send("Reloadly server running");
});

app.listen(PORT, () =>
console.log(`🚀 Serveur actif sur port ${PORT}`)
);
