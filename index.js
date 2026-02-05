import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();

/* =======================
CONFIG
======================= */
const {
SHOPIFY_WEBHOOK_SECRET,
RELOADLY_CLIENT_ID,
RELOADLY_CLIENT_SECRET,
RELOADLY_ENV = "production",
PORT
} = process.env;

const RELOADLY_BASE_URL =
RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com";

/* =======================
MIDDLEWARE
======================= */
app.use(
express.raw({
type: "application/json",
})
);

/* =======================
UTILS
======================= */
function verifyShopifyWebhook(req) {
if (!SHOPIFY_WEBHOOK_SECRET) return true;

const hmac = req.headers["x-shopify-hmac-sha256"];
if (!hmac) return false;

const digest = crypto
.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
.update(req.body)
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(digest, "utf8"),
Buffer.from(hmac, "utf8")
);
}

function normalizeHaitiPhone(phone) {
return phone
.replace(/\s+/g, "")
.replace("+509", "")
.replace(/^509/, "");
}

async function getReloadlyToken() {
const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: RELOADLY_BASE_URL,
},
{ headers: { "Content-Type": "application/json" } }
);
return res.data.access_token;
}

/* =======================
WEBHOOK SHOPIFY (orders/paid)
======================= */
app.post("/webhook", async (req, res) => {
try {
if (!verifyShopifyWebhook(req)) {
console.log("❌ Webhook Shopify invalide");
return res.status(401).send("Unauthorized");
}

const order = JSON.parse(req.body.toString());

/* 🔐 BLOCAGE CRITIQUE */
if (order.financial_status !== "paid") {
console.log("⏸️ Commande non payée – ignorée");
return res.status(200).send("Not paid");
}

console.log("✅ Webhook Shopify PAYÉ reçu");
console.log("🧾 Commande ID:", order.id);
console.log("🧩 Checkout ID:", order.checkout_id);

/* ===== EXTRACTION DONNÉES ===== */
let phone = null;
let amount = null;

for (const item of order.line_items || []) {
for (const prop of item.properties || []) {
if (
prop.name.toLowerCase().includes("numéro") ||
prop.name.toLowerCase().includes("numero")
) {
phone = prop.value;
}
if (prop.name.toLowerCase().includes("montant")) {
amount = parseFloat(prop.value);
}
}
}

if (!amount) amount = parseFloat(order.total_price);

console.log("📱 Numéro reçu:", phone);
console.log("💰 Montant reçu:", amount);

if (!phone || !amount || isNaN(amount) || amount <= 0) {
console.log("❌ Données invalides");
return res.status(200).send("Invalid data");
}

const cleanPhone = normalizeHaitiPhone(phone);

/* ===== AUTH RELOADLY ===== */
const token = await getReloadlyToken();

/* ===== AUTO-DETECT OPÉRATEUR ===== */
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

/* ===== CLÉ UNIQUE ANTI-DOUBLON (ULTIME) ===== */
const rechargeReference = `shopify-checkout-${order.checkout_id}`;

/* ===== RECHARGE ===== */
const topupRes = await axios.post(
`${RELOADLY_BASE_URL}/topups`,
{
operatorId,
amount,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: cleanPhone,
},
referenceId: rechargeReference,
},
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json",
},
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", topupRes.data.transactionId);

res.status(200).send("Recharge success");
} catch (err) {
if (
err.response?.status === 409 &&
err.response?.data?.message?.toLowerCase().includes("duplicate")
) {
console.log("⚠️ Recharge déjà effectuée – duplication bloquée");
return res.status(200).send("Duplicate blocked");
}

console.error(
"❌ Erreur recharge:",
err.response?.data || err.message
);
res.status(200).send("Error handled");
}
});

/* =======================
HEALTH CHECK
======================= */
app.get("/", (req, res) => {
res.send("✅ Reloadly Shopify Server OK");
});

/* =======================
START
======================= */
app.listen(PORT || 10000, () => {
console.log(`🚀 Serveur lancé sur port ${PORT || 10000}`);
});
