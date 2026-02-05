import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();

/* =========================
CONFIG
========================= */
const PORT = process.env.PORT || 10000;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

/* =========================
MIDDLEWARE
========================= */
app.use(express.json({
verify: (req, res, buf) => {
req.rawBody = buf;
}
}));

/* =========================
UTILITAIRES
========================= */
function verifyShopifyWebhook(req) {
const hmac = req.headers["x-shopify-hmac-sha256"];
const digest = crypto
.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
.update(req.rawBody)
.digest("base64");

return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
}

async function getReloadlyToken() {
const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
}
);
return res.data.access_token;
}

async function retry(fn, attempts = 5, delay = 2000) {
let lastError;
for (let i = 1; i <= attempts; i++) {
try {
return await fn();
} catch (err) {
lastError = err;
console.log(`🔁 Retry ${i}/${attempts} échoué`);
await new Promise(r => setTimeout(r, delay));
}
}
throw lastError;
}

/* =========================
WEBHOOK SHOPIFY
========================= */
app.post("/webhook", async (req, res) => {
try {
if (!verifyShopifyWebhook(req)) {
console.log("❌ Webhook Shopify invalide");
return res.status(401).send("Unauthorized");
}

console.log("✅ WEBHOOK SHOPIFY REÇU");

const order = req.body;

const properties = order.line_items?.[0]?.properties || [];

console.log("📦 PROPRIÉTÉS :", properties);

const phone = properties.find(p =>
p.name.toLowerCase().includes("numéro")
)?.value || null;

const amountRaw = properties.find(p =>
p.name.toLowerCase().includes("montant")
)?.value || null;

const amount = amountRaw ? parseFloat(amountRaw) : null;

if (!phone || !amount || isNaN(amount)) {
console.log("❌ Données invalides", phone, amount);
return res.status(200).send("Données invalides");
}

console.log("📱 Numéro :", phone);
console.log("💰 Montant :", amount);

/* =========================
AUTH RELOADLY
========================= */
const token = await getReloadlyToken();

/* =========================
DÉTECTION OPÉRATEUR
========================= */
const operatorRes = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}`,
{ headers: { Authorization: `Bearer ${token}` } }
);

const operatorId = operatorRes.data.operatorId;

console.log("📡 Opérateur détecté :", operatorId);

/* =========================
RECHARGE AVEC RETRY
========================= */
const recharge = async () => {
return axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: phone.replace("+509", "")
}
},
{ headers: { Authorization: `Bearer ${token}` } }
);
};

const result = await retry(recharge, 5);

console.log("✅ RECHARGE RÉUSSIE", result.data.transactionId);

res.status(200).send("Recharge effectuée");
} catch (err) {
console.error("❌ Erreur recharge :", err.response?.data || err.message);
res.status(200).send("Erreur traitée");
}
});

/* =========================
SERVER
========================= */
app.get("/", (req, res) => {
res.send("Reloadly server OK");
});

app.listen(PORT, () => {
console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
