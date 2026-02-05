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
const RELOADLY_ENV = "https://auth.reloadly.com"; // PROD

/* =========================
MÉMOIRE SIMPLE (ANTI DUP)
(pour prod long terme → DB)
========================= */
const processedOrders = new Set();

/* =========================
UTIL : SLEEP
========================= */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* =========================
AUTH RELOADLY
========================= */
async function getReloadlyToken() {
const res = await axios.post(
`${RELOADLY_ENV}/oauth/token`,
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
DÉTECTION OPÉRATEUR
========================= */
function detectOperator(phone) {
if (phone.startsWith("5093") || phone.startsWith("5094")) return 173; // Digicel Haiti
if (phone.startsWith("5095") || phone.startsWith("5096")) return 174; // Natcom Haiti
throw new Error("Opérateur non reconnu");
}

/* =========================
RECHARGE AVEC RETRY
========================= */
async function processRecharge({ orderId, phone, amount }) {

if (processedOrders.has(orderId)) {
console.log("⛔ Recharge déjà effectuée pour", orderId);
return;
}

processedOrders.add(orderId);

const operatorId = detectOperator(phone);
const token = await getReloadlyToken();

const payload = {
operatorId,
amount,
useLocalAmount: false,
customIdentifier: orderId,
recipientPhone: {
countryCode: "HT",
number: phone.replace("509", "")
}
};

const MAX_RETRIES = 5;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
try {
console.log(`🔁 Tentative ${attempt} pour commande ${orderId}`);

const res = await axios.post(
"https://topups.reloadly.com/topups",
payload,
{
headers: {
Authorization: `Bearer ${token}`,
"Content-Type": "application/json",
Accept: "application/com.reloadly.topups-v1+json"
}
}
);

console.log("✅ Recharge réussie :", res.data);
return;

} catch (err) {
console.error(`❌ Tentative ${attempt} échouée`);

if (attempt === MAX_RETRIES) {
console.error("🚨 Recharge abandonnée définitivement", err.response?.data || err.message);
return;
}

// Retry différé (progressif)
await sleep(attempt * 5000); // 5s, 10s, 15s, 20s...
}
}
}

/* =========================
WEBHOOK SHOPIFY
========================= */
app.post("/webhook", async (req, res) => {
try {
const order = req.body;

// sécurité : uniquement commandes payées
if (order.financial_status !== "paid") {
return res.status(200).send("Commande non payée");
}

const orderId = order.id;

let phone = null;
let amount = null;

for (const item of order.line_items) {
if (item.properties) {
for (const prop of item.properties) {
if (prop.name === "Numéro à recharger") phone = prop.value;
if (prop.name === "Montant recharge") amount = Number(prop.value);
}
}
}

if (!phone || !amount) {
console.error("❌ Données invalides", phone, amount);
return res.status(400).send("Données invalides");
}

console.log("📥 WEBHOOK REÇU", { orderId, phone, amount });

await processRecharge({ orderId, phone, amount });

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
res.send("🚀 Serveur Recharge 100% automatique actif");
});

/* =========================
START
========================= */
app.listen(PORT, () => {
console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
