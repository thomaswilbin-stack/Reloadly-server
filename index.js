import express from "express";
import crypto from "crypto";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 10000;

// 🔐 Capture du body brut pour Shopify
app.use(
express.json({
verify: (req, res, buf) => {
req.rawBody = buf;
},
})
);

// 🔒 Anti-doublon en mémoire
const processing = new Set();

// 🔐 Vérification signature Shopify
function verifyShopifyWebhook(req) {
const hmac = req.get("X-Shopify-Hmac-Sha256");
const digest = crypto
.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
.update(req.rawBody)
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(hmac, "utf8"),
Buffer.from(digest, "utf8")
);
}

// 🟢 Health check
app.get("/", (req, res) => {
res.send("Reloadly server running");
});

// 🟣 WEBHOOK SHOPIFY PAYÉ
app.post("/webhook/shopify-paid", async (req, res) => {
try {
console.log("📥 Webhook Shopify reçu");

if (!verifyShopifyWebhook(req)) {
console.log("❌ Signature Shopify invalide");
return res.status(401).send("Invalid HMAC");
}

const order = req.body;
const lockKey = `checkout-${order.checkout_id}`;

// 🔒 Anti-doublon serveur
if (processing.has(lockKey)) {
console.log("🔒 Recharge déjà en cours — bloquée");
return res.status(200).send("Already processing");
}

processing.add(lockKey);

const phone = order?.note_attributes?.find(
(a) => a.name === "phone"
)?.value;

const amount = parseFloat(order?.line_items?.[0]?.price);

if (!phone || !amount) {
console.log("❌ Données invalides", phone, amount);
processing.delete(lockKey);
return res.status(400).send("Invalid data");
}

console.log("📱 Numéro reçu:", phone);
console.log("💰 Montant reçu:", amount);

// 🔑 Auth Reloadly
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

// 📡 Détection opérateur automatique
const detected = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone.replace(
"+",
""
)}?countryCode=HT`,
{
headers: { Authorization: `Bearer ${token}` },
}
);

const operatorId = detected.data.operatorId;
console.log("📡 Opérateur détecté:", detected.data.name);

// 💸 Recharge automatique
const recharge = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: true,
customIdentifier: lockKey,
recipientPhone: {
countryCode: "HT",
number: phone.replace("+509", ""),
},
},
{
headers: { Authorization: `Bearer ${token}` },
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", recharge.data.transactionId);

res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur recharge:", err.response?.data || err.message);
res.status(500).send("Error");
} finally {
processing.clear();
}
});

app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
