import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================================================
1️⃣ Shopify RAW BODY (OBLIGATOIRE)
========================================================= */
app.use(
express.json({
verify: (req, res, buf) => {
req.rawBody = buf;
},
})
);

/* =========================================================
2️⃣ Mémoire anti-doublon (idempotence)
👉 clé = checkout_id (le plus fiable)
========================================================= */
const processedCheckouts = new Set();

/* =========================================================
3️⃣ Vérification HMAC Shopify
========================================================= */
function verifyShopifyWebhook(req) {
const hmac = req.get("X-Shopify-Hmac-Sha256");
if (!hmac) return false;

const digest = crypto
.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
.update(req.rawBody)
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(hmac, "utf8"),
Buffer.from(digest, "utf8")
);
}

/* =========================================================
4️⃣ Health check
========================================================= */
app.get("/", (req, res) => {
res.send("Reloadly server running");
});

/* =========================================================
5️⃣ WEBHOOK SHOPIFY — COMMANDE PAYÉE
========================================================= */
app.post("/webhook/shopify-paid", async (req, res) => {
console.log("\n📥 Webhook Shopify PAYÉ reçu");

/* --- Sécurité Shopify --- */
if (!verifyShopifyWebhook(req)) {
console.log("❌ Signature Shopify invalide");
return res.status(401).send("Invalid signature");
}

const order = req.body;

const checkoutId = order.checkout_id;
const orderId = order.id;

console.log("🧾 Commande ID:", orderId);
console.log("🧩 Checkout ID:", checkoutId);

/* --- Anti-doublon ABSOLU --- */
if (processedCheckouts.has(checkoutId)) {
console.log("🔒 Doublon détecté — recharge BLOQUÉE");
return res.status(200).send("Already processed");
}

/* --- Verrou immédiat (AVANT Reloadly) --- */
processedCheckouts.add(checkoutId);

try {
/* =====================================================
Données client
===================================================== */
const phone = order?.note_attributes?.find(
(a) => a.name === "phone"
)?.value;

const amount = Number(order?.line_items?.[0]?.price);

console.log("📱 Numéro reçu:", phone);
console.log("💰 Montant reçu:", amount);

if (!phone || !amount || isNaN(amount)) {
throw new Error("Données invalides");
}

/* =====================================================
Auth Reloadly
===================================================== */
const auth = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com",
}
);

const token = auth.data.access_token;

/* =====================================================
Détection opérateur automatique
===================================================== */
const cleanPhone = phone.replace("+509", "");

const detect = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${cleanPhone}?countryCode=HT`,
{
headers: { Authorization: `Bearer ${token}` },
}
);

const operatorId = detect.data.operatorId;
console.log("📡 Opérateur détecté:", detect.data.name);

/* =====================================================
Recharge automatique
👉 customIdentifier = checkoutId (clé anti-doublon Reloadly)
===================================================== */
const recharge = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: true,
customIdentifier: checkoutId,
recipientPhone: {
countryCode: "HT",
number: cleanPhone,
},
},
{
headers: { Authorization: `Bearer ${token}` },
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", recharge.data.transactionId);

return res.status(200).send("OK");
} catch (err) {
console.error(
"❌ Erreur recharge:",
err.response?.data || err.message
);

/*
⚠️ IMPORTANT
On NE retire PAS le checkoutId du Set
👉 même si Reloadly retourne une erreur temporaire,
Shopify ne pourra PAS déclencher un doublon
*/

return res.status(200).send("Processed");
}
});

/* =========================================================
6️⃣ Lancement serveur
========================================================= */
app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
