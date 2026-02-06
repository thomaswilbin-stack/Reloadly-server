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
ANTI-DOUBLON ABSOLU
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

/* ===== CLÉ UNIQUE ANTI-DOUBLON ===== */
const uniqueKey =
data.checkout_id ||
data.id ||
data.order_number;

console.log("\n✅ Webhook PAYÉ reçu");
console.log("🧾 Order ID:", data.id);
console.log("🧩 Checkout ID:", data.checkout_id);
console.log("🔑 Clé anti-doublon:", uniqueKey);

if (processedKeys.has(uniqueKey)) {
console.log("🛑 Doublon détecté → ignoré");
return res.status(200).send("Already processed");
}
processedKeys.add(uniqueKey);

/* ===== DÉTECTION NUMÉRO (100 %) ===== */
const phone =
data.phone || // ✅ CAS LE PLUS FRÉQUENT (ORDER PHONE)
data.note_attributes?.find(n =>
["phone", "numero", "numéro"].includes(
n.name?.toLowerCase()
)
)?.value ||
data.line_items?.[0]?.properties?.find(p =>
["phone", "numero", "numéro"].includes(
p.name?.toLowerCase()
)
)?.value ||
data.shipping_address?.phone ||
data.billing_address?.phone ||
data.customer?.phone ||
data.customer?.default_address?.phone ||
null;

/* ===== MONTANT ===== */
const amount =
Number(data.line_items?.[0]?.price) ||
Number(data.total_price) ||
null;

console.log("📱 Numéro détecté:", phone);
console.log("💰 Montant détecté:", amount);

if (!phone || !amount || amount <= 0) {
console.log("❌ Données manquantes");
return res.status(200).send("Missing data");
}

/* ===== FORMAT NUMÉRO ===== */
const cleanPhone = phone.replace(/\D/g, "");

if (!cleanPhone.startsWith("509") || cleanPhone.length !== 11) {
console.log("❌ Numéro invalide:", cleanPhone);
return res.status(200).send("Invalid phone");
}

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

/* ===== AUTO-DÉTECTION OPÉRATEUR ===== */
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
customIdentifier: uniqueKey, // 🔒 Reloadly anti-doublon
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

// IMPORTANT : répondre 200 pour bloquer retry Shopify
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
