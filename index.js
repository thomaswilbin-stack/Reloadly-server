import express from "express";
import axios from "axios";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

/* =========================
VARIABLES ENV (RENDER)
========================= */
const PORT = process.env.PORT || 3000;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;

/* =========================
ANTI-DUPLICATION
========================= */
const processedOrders = new Set();

/* =========================
UTILS
========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* =========================
AUTH RELOADLY
========================= */
async function getReloadlyToken() {
const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
},
{ headers: { "Content-Type": "application/json" } }
);

return res.data.access_token;
}

/* =========================
AUTO-DETECT OPÉRATEUR (RELOADLY)
========================= */
async function detectOperatorViaReloadly(phone, token) {
const cleanPhone = phone.replace("+", "");

const res = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${cleanPhone}?countryCode=HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json"
}
}
);

if (!res.data?.operatorId) {
throw new Error("Opérateur non détecté");
}

console.log("📡 Opérateur détecté :", res.data.name);
return res.data.operatorId;
}

/* =========================
PROCESS RECHARGE (5 RETRIES)
========================= */
async function processRecharge({ orderId, phone, amount }) {

if (processedOrders.has(orderId)) {
console.log("⛔ Recharge déjà traitée :", orderId);
return;
}

processedOrders.add(orderId);

const token = await getReloadlyToken();
const operatorId = await detectOperatorViaReloadly(phone, token);

const payload = {
operatorId,
amount,
useLocalAmount: false,
customIdentifier: orderId,
recipientPhone: {
countryCode: "HT",
number: phone.replace("+509", "").replace("509", "")
}
};

const MAX_RETRIES = 5;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
try {
console.log(`🔁 Tentative ${attempt} | Commande ${orderId}`);

const res = await axios.post(
"https://topups.reloadly.com/topups",
payload,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json"
}
}
);

console.log("✅ Recharge réussie :", res.data.transactionId);
return;

} catch (err) {
console.error(`❌ Échec tentative ${attempt}`);

if (attempt === MAX_RETRIES) {
console.error("🚨 Recharge abandonnée", err.response?.data || err.message);
return;
}

await sleep(attempt * 5000); // 5s, 10s, 15s, 20s, 25s
}
}
}

/* =========================
WEBHOOK SHOPIFY
========================= */
app.post("/webhook", async (req, res) => {
try {
const order = req.body;

if (order.financial_status !== "paid") {
return res.status(200).send("Commande non payée");
}

let phone = null;
let amount = null;

for (const item of order.line_items) {
if (item.properties) {
console.log("🧪 PROPRIÉTÉS :", item.properties);

for (const prop of item.properties) {
const name = prop.name.toLowerCase();

if (name.includes("numéro")) phone = prop.value;
if (name.includes("montant")) amount = Number(prop.value);
}
}
}

if (!phone || !amount || isNaN(amount)) {
console.error("❌ Données invalides", phone, amount);
return res.status(400).send("Données invalides");
}

console.log("📥 WEBHOOK OK", { phone, amount });

await processRecharge({
orderId: order.id,
phone,
amount
});

res.status(200).send("OK");

} catch (err) {
console.error("❌ Erreur webhook", err.message);
res.status(500).send("Erreur serveur");
}
});

/* =========================
ROUTE TEST
========================= */
app.get("/", (req, res) => {
res.send("🚀 Serveur Recharge 100 % automatique ACTIF");
});

/* =========================
START
========================= */
app.listen(PORT, () => {
console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
