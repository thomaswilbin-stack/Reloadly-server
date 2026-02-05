import express from "express";
import axios from "axios";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

/* =========================
CONFIG
========================= */

const PORT = process.env.PORT || 3000;
const RELOADLY_AUTH_URL = "https://auth.reloadly.com/oauth/token";
const RELOADLY_TOPUP_URL = "https://topups.reloadly.com/topups";

/* =========================
MÉMOIRE ANTI-DUPLICATION
========================= */

const processedOrders = new Set();
const pendingRecharges = new Map();

/* =========================
AUTH RELOADLY
========================= */

async function getReloadlyToken() {
const res = await axios.post(RELOADLY_AUTH_URL, {
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
});

return res.data.access_token;
}

/* =========================
RECHARGE AVEC 2 RETRIES IMMÉDIATS
========================= */

async function reloadlyRecharge(payload, orderId) {
let attempts = 0;

while (attempts < 2) {
try {
attempts++;
const token = await getReloadlyToken();

await axios.post(RELOADLY_TOPUP_URL, payload, {
headers: {
Authorization: `Bearer ${token}`,
"Content-Type": "application/json",
Accept: "application/com.reloadly.topups-v1+json"
}
});

console.log(`✅ Recharge réussie (commande ${orderId})`);
processedOrders.add(orderId);
pendingRecharges.delete(orderId);
return;

} catch (err) {
console.error(`❌ Tentative ${attempts} échouée`, err.response?.data || err.message);
if (attempts >= 2) throw err;
await new Promise(r => setTimeout(r, 2000));
}
}
}

/* =========================
WEBHOOK SHOPIFY
========================= */

app.post("/webhook", async (req, res) => {
try {
const orderId = req.body.id;
if (processedOrders.has(orderId)) {
return res.status(200).send("Déjà traité");
}

const phone = req.body.note_attributes?.find(
f => f.name === "Numéro à recharger"
)?.value;

if (!phone) {
console.error("❌ Numéro manquant");
return res.status(400).send("Numéro invalide");
}

const amount = req.body.total_price;
const operatorId = phone.startsWith("5097") ? 173 : 174;

const payload = {
operatorId,
amount: Number(amount),
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: phone.replace("509", "")
}
};

try {
await reloadlyRecharge(payload, orderId);
} catch (e) {
console.log("⏸️ Recharge mise en attente");
pendingRecharges.set(orderId, {
payload,
attempts: 2
});
}

res.status(200).send("Webhook reçu");

} catch (e) {
console.error("❌ Erreur webhook", e.message);
res.status(500).send("Erreur serveur");
}
});

/* =========================
RETRY DIFFÉRÉ (3 FOIS)
========================= */

setInterval(async () => {
for (const [orderId, job] of pendingRecharges) {
if (job.attempts >= 5) {
console.error(`🛑 Abandon recharge ${orderId}`);
pendingRecharges.delete(orderId);
continue;
}

try {
job.attempts++;
console.log(`🔁 Retry différé ${job.attempts}/5 (${orderId})`);

const token = await getReloadlyToken();
await axios.post(RELOADLY_TOPUP_URL, job.payload, {
headers: {
Authorization: `Bearer ${token}`,
"Content-Type": "application/json",
Accept: "application/com.reloadly.topups-v1+json"
}
});

console.log(`✅ Recharge réussie après retry`);
processedOrders.add(orderId);
pendingRecharges.delete(orderId);

} catch (e) {
console.log(`⏳ Toujours en attente (${job.attempts}/5)`);
}
}
}, 5 * 60 * 1000);

/* =========================
START
========================= */

app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur le port ${PORT}`);
});
