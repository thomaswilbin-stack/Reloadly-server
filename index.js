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
MEMOIRE ANTI-DOUBLON
(Render garde ça en RAM)
========================= */
const processedOrders = new Set();

/* =========================
RAW BODY (OBLIGATOIRE)
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

const orderId = data.id;
const checkoutId = data.checkout_id;
const uniqueKey = `${orderId}-${checkoutId}`;

console.log("✅ Webhook PAYÉ reçu");
console.log("Commande:", orderId);
console.log("Checkout:", checkoutId);

/* ===== ANTI-DOUBLON ABSOLU ===== */
if (processedOrders.has(uniqueKey)) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}

processedOrders.add(uniqueKey);

/* ===== Récupération données ===== */
const phone = data.note_attributes?.find(
(n) => n.name === "phone"
)?.value;

const amount = data.line_items?.[0]?.price;

if (!phone || !amount) {
console.log("❌ Données manquantes");
return res.status(200).send("Missing data");
}

console.log("📱 Numéro:", phone);
console.log("💰 Montant:", amount);

/* ===== TOKEN Reloadly ===== */
const auth = await axios.post(
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

const token = auth.data.access_token;

/* ===== Auto-détection opérateur ===== */
const cleanPhone = phone.replace("+", "");

const detect = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${cleanPhone}?countryCode=HT`,
{
headers: { Authorization: `Bearer ${token}` },
}
);

const operatorId = detect.data.operatorId;

console.log("📡 Opérateur:", detect.data.name);

/* ===== Recharge ===== */
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
customIdentifier: uniqueKey, // 🔒 sécurité supplémentaire Reloadly
},
{
headers: { Authorization: `Bearer ${token}` },
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("Transaction:", topup.data.transactionId);

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur:", err.response?.data || err.message);

// ⚠️ ON RÉPOND TOUJOURS 200 POUR ÉVITER RETRY SHOPIFY
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
