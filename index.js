import express from "express";
import crypto from "crypto";
import axios from "axios";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 10000;

/* ===========================
ANTI-DOUBLON (IDEMPOTENCY)
=========================== */
const STORE_FILE = "./processed.json";

// Charger les transactions déjà traitées
let processed = new Set();
if (fs.existsSync(STORE_FILE)) {
const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
processed = new Set(data);
}

function saveProcessed() {
fs.writeFileSync(STORE_FILE, JSON.stringify([...processed]));
}

/* ===========================
WEBHOOK SHOPIFY PAYÉ
=========================== */
app.post(
"/webhook/shopify-paid",
express.raw({ type: "application/json" }),
async (req, res) => {
try {
console.log("✅ Webhook Shopify PAYÉ reçu");

/* ===== 1. VALIDATION HMAC ===== */
const hmac = req.headers["x-shopify-hmac-sha256"];
const digest = crypto
.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
.update(req.body)
.digest("base64");

if (digest !== hmac) {
console.log("❌ HMAC invalide");
return res.status(401).send("Unauthorized");
}

/* ===== 2. PARSE ===== */
const payload = JSON.parse(req.body.toString());

const orderId = payload.id;
const checkoutId = payload.checkout_id;
const amount = payload.total_price;

const phone = payload.note_attributes?.find(
(n) => n.name === "phone"
)?.value;

if (!phone || !amount) {
console.log("❌ Données manquantes");
return res.status(200).send("Ignored");
}

/* ===== 3. CLÉ UNIQUE ANTI-DOUBLON ===== */
const key = `${orderId}-${checkoutId}-${phone}-${amount}`;

if (processed.has(key)) {
console.log("🛑 DOUBLON BLOQUÉ — Recharge déjà traitée");
return res.status(200).send("Duplicate ignored");
}

// Verrou immédiat (anti race-condition)
processed.add(key);
saveProcessed();

console.log("🔒 Transaction verrouillée:", key);

/* ===== 4. DÉTECTION OPÉRATEUR ===== */
const operatorRes = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone.replace(
"+",
""
)}`,
{
headers: {
Authorization: `Bearer ${process.env.RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
},
}
);

const operatorId = operatorRes.data.operatorId;
console.log("📡 Opérateur détecté:", operatorRes.data.name);

/* ===== 5. RECHARGE ===== */
const topupRes = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount: Number(amount),
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: phone.replace("+509", ""),
},
},
{
headers: {
Authorization: `Bearer ${process.env.RELOADLY_TOKEN}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json",
},
}
);

console.log("🎉 RECHARGE RÉUSSIE");
console.log("🆔 Transaction Reloadly:", topupRes.data.transactionId);

return res.status(200).send("OK");
} catch (err) {
console.log(
"❌ Erreur webhook:",
err.response?.data || err.message
);
return res.status(200).send("Handled");
}
}
);

/* ===========================
ROUTE TEST
=========================== */
app.get("/", (req, res) => {
res.send("Reloadly server running");
});

app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
