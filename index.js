import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Stockage temporaire (semi-automatique)
const pendingRecharges = {};
let reloadlyToken = null;

/* ===========================
🔐 AUTHENTIFICATION RELOADLY
=========================== */
async function getReloadlyToken() {
if (reloadlyToken) return reloadlyToken;

const audience =
process.env.RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com";

const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience
},
{ headers: { "Content-Type": "application/json" } }
);

reloadlyToken = res.data.access_token;
console.log("🔐 Reloadly authentifié");
return reloadlyToken;
}

/* ===========================
🧾 WEBHOOK SHOPIFY
=========================== */
app.post("/webhook", (req, res) => {
try {
const order = req.body;
const orderId = order.id;

let phone = null;

// 🔎 Cherche le numéro dans les produits
for (const item of order.line_items || []) {
for (const prop of item.properties || []) {
if (
prop.name.toLowerCase().includes("num") ||
prop.name.toLowerCase().includes("phone")
) {
phone = prop.value;
}
}
}

if (!phone) {
console.log("❌ Numéro reçu null");
return res.status(400).send("Numéro manquant");
}

pendingRecharges[orderId] = {
phone,
amount: Number(order.total_price),
currency: order.currency || "USD"
};

console.log("✅ WEBHOOK SHOPIFY REÇU");
console.log("🧾 Commande ID :", orderId);
console.log("📱 Numéro à recharger :", phone);
console.log("⏸️ Recharge en attente");

res.sendStatus(200);
} catch (err) {
console.error("❌ Erreur webhook :", err.message);
res.sendStatus(500);
}
});

/* ===========================
📋 VOIR LES RECHARGES EN ATTENTE
=========================== */
app.get("/pending-recharges", (req, res) => {
res.json(pendingRecharges);
});

/* ===========================
✅ CONFIRMER UNE RECHARGE
=========================== */
app.get("/confirm/:orderId", async (req, res) => {
const { orderId } = req.params;
const recharge = pendingRecharges[orderId];

if (!recharge) {
return res.status(404).send("Commande introuvable");
}

try {
const token = await getReloadlyToken();

// 🔎 Détection opérateur
const operatorRes = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${recharge.phone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json"
}
}
);

const operatorId = operatorRes.data.operatorId;
console.log("📡 Opérateur détecté :", operatorRes.data.name);

// 💸 Lancer la recharge
const topupRes = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount: recharge.amount,
useLocalAmount: false,
customIdentifier: `order-${orderId}`,
recipientPhone: {
countryCode: "HT",
number: recharge.phone.replace("+509", "").replace("509", "")
}
},
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json"
}
}
);

delete pendingRecharges[orderId];

console.log("✅ Recharge effectuée avec succès");
res.json({
success: true,
orderId,
transaction: topupRes.data
});
} catch (err) {
console.error("❌ Erreur recharge :", err.response?.data || err.message);
res.status(500).send("Erreur recharge");
}
});

/* ===========================
🚀 SERVEUR
=========================== */
app.get("/", (req, res) => {
res.send("Reloadly server actif");
});

app.listen(PORT, () => {
console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
