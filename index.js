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
MEMOIRE ANTI-DOUBLON (RAM)
========================= */
const processedOrders = new Set();

/* =========================
WEBHOOK SHOPIFY
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

/* ===== CLÉ UNIQUE ANTI-DOUBLON 🔧 FIX ===== */
const uniqueKey =
data.checkout_id ||
data.order_number ||
data.id;

console.log("✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

/* ===== ANTI-DOUBLON ABSOLU ===== */
if (processedOrders.has(uniqueKey)) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}

processedOrders.add(uniqueKey);

/* ===== DONNÉES COMMANDE ===== */
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

/* ===== TOKEN RELOADLY ===== */
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

/* ===== DÉTECTION OPÉRATEUR ===== */
const cleanPhone = phone.replace("+", "");

const detect = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${cleanPhone}?countryCode=HT`,
{
headers: { Authorization: `Bearer ${token}` },
}
);

const operatorId = detect.data.operatorId;
console.log("📡 Opérateur détecté:", detect.data.name);

/* ===== RECHARGE ===== */
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
customIdentifier: uniqueKey, // 🔒 anti-doublon Reloadly aussi
},
{
headers: { Authorization: `Bearer ${token}` },
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction:", topup.data.transactionId);

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur:", err.response?.data || err.message);

// ⚠️ Toujours 200 pour éviter retry Shopify
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
START SERVER
========================= */
app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
