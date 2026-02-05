import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();

// ================== CONFIG ==================
const {
SHOPIFY_WEBHOOK_SECRET,
RELOADLY_CLIENT_ID,
RELOADLY_CLIENT_SECRET,
RELOADLY_ENV = "production", // sandbox | production
PORT
} = process.env;

const reloadlyBaseUrl =
RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com";

// ================== MIDDLEWARE ==================
app.use(
express.raw({
type: "application/json",
})
);

// ================== ANTI-DOUBLON ==================
const processedOrders = new Set();

// ================== UTILS ==================
function verifyShopifyWebhook(req) {
const hmac = req.headers["x-shopify-hmac-sha256"];
const digest = crypto
.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
.update(req.body)
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(digest),
Buffer.from(hmac)
);
}

async function getReloadlyToken() {
const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: reloadlyBaseUrl,
},
{ headers: { "Content-Type": "application/json" } }
);
return res.data.access_token;
}

// ================== WEBHOOK ==================
app.post("/webhook", async (req, res) => {
try {
if (!verifyShopifyWebhook(req)) {
console.log("❌ Webhook invalide");
return res.status(401).send("Invalid webhook");
}

const order = JSON.parse(req.body.toString());

if (processedOrders.has(order.id)) {
console.log("⚠️ Commande déjà traitée :", order.id);
return res.status(200).send("Already processed");
}

processedOrders.add(order.id);

console.log("✅ WEBHOOK SHOPIFY REÇU");
console.log("🧾 Commande :", order.id);

// ========= EXTRACTION DONNÉES =========
let phone = null;
let amount = Number(order.total_price);

for (const item of order.line_items) {
if (item.properties) {
for (const prop of item.properties) {
if (
prop.name.toLowerCase().includes("numéro") ||
prop.name.toLowerCase().includes("numero")
) {
phone = prop.value;
}
}
}
}

console.log("📱 Numéro reçu :", phone);
console.log("💰 Montant reçu :", amount);

if (!phone || !amount || amount <= 0) {
console.log("❌ Données invalides", phone, amount);
return res.status(200).send("Invalid data");
}

// ========= RELOADLY =========
const token = await getReloadlyToken();

// 🔎 Détection opérateur
const detectRes = await axios.get(
`${reloadlyBaseUrl}/operators/auto-detect/phone/${phone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/json",
},
}
);

const operatorId = detectRes.data.operatorId;
console.log("📡 Opérateur détecté :", operatorId);

// ⚡ Recharge
const topupRes = await axios.post(
`${reloadlyBaseUrl}/topups`,
{
operatorId,
amount,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: phone.replace("+509", ""),
},
referenceId: `shopify-${order.id}`,
},
{
headers: {
Authorization: `Bearer ${token}`,
"Content-Type": "application/json",
},
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction :", topupRes.data.transactionId);

res.status(200).send("Recharge success");
} catch (err) {
console.error(
"❌ Erreur recharge :",
err.response?.data || err.message
);
res.status(200).send("Error handled");
}
});

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
res.send("✅ Reloadly Shopify Server OK");
});

// ================== START ==================
app.listen(PORT || 10000, () => {
console.log(`🚀 Serveur lancé sur port ${PORT || 10000}`);
});
