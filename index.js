import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();

/* ⚠️ IMPORTANT : body RAW pour Shopify */
app.use(
"/webhook",
express.raw({ type: "application/json" })
);

/* ---------------- CONFIG ---------------- */
const PORT = process.env.PORT || 10000;
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_ENV = process.env.RELOADLY_ENV || "production";

/* Anti-doublon mémoire (béton simple) */
const processedCheckouts = new Set();

/* ---------------- HELPERS ---------------- */
function verifyShopifyWebhook(req) {
const hmac = req.headers["x-shopify-hmac-sha256"];
const hash = crypto
.createHmac("sha256", SHOPIFY_SECRET)
.update(req.body)
.digest("base64");

return hash === hmac;
}

/* ---------------- WEBHOOK ---------------- */
app.post("/webhook", async (req, res) => {
try {
if (!verifyShopifyWebhook(req)) {
console.log("❌ Webhook non authentifié");
return res.status(401).send("Invalid webhook");
}

const payload = JSON.parse(req.body.toString());

if (payload.financial_status !== "paid") {
return res.status(200).send("Ignored");
}

const checkoutId = payload.checkout_id;
const orderId = payload.id;

if (processedCheckouts.has(checkoutId)) {
console.log("⛔ Doublon bloqué checkout:", checkoutId);
return res.status(200).send("Duplicate ignored");
}

processedCheckouts.add(checkoutId);

console.log("✅ Webhook PAYÉ reçu");
console.log("Commande:", orderId);

const phone = payload.note_attributes?.find(
(n) => n.name === "phone"
)?.value;

const amount = Number(payload.line_items?.[0]?.price);

if (!phone || !amount) {
console.log("❌ Données manquantes");
return res.status(200).send("Missing data");
}

/* ---- TOKEN RELOADLY ---- */
const tokenRes = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience:
RELOADLY_ENV === "sandbox"
? "https://topups-sandbox.reloadly.com"
: "https://topups.reloadly.com",
}
);

const token = tokenRes.data.access_token;

/* ---- DETECTION OPERATEUR ---- */
const cleanPhone = phone.replace("+509", "");

const operatorRes = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${cleanPhone}?countryCode=HT`,
{
headers: { Authorization: `Bearer ${token}` },
}
);

const operatorId = operatorRes.data.operatorId;
console.log("📡 Opérateur détecté:", operatorRes.data.name);

/* ---- RECHARGE ---- */
const topupRes = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: true,
recipientPhone: {
countryCode: "HT",
number: cleanPhone,
},
reference: `shopify-${orderId}`,
},
{
headers: { Authorization: `Bearer ${token}` },
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("Transaction:", topupRes.data.transactionId);

res.status(200).send("OK");
} catch (err) {
console.log("❌ Erreur:", err.response?.data || err.message);
res.status(200).send("Handled");
}
});

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (req, res) => {
res.send("Reloadly server running");
});

/* ---------------- START ---------------- */
app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
