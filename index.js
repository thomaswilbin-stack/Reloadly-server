import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===============================
// CONFIG
// ===============================
const PORT = process.env.PORT || 3000;
const RELOADLY_ENV = process.env.RELOADLY_ENV || "sandbox";

const TOPUP_BASE =
RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com";

const AUTH_AUDIENCE =
RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com";

// ===============================
// MEMORY (simple)
// ===============================
let reloadlyToken = null;
const pendingRecharges = {};

// ===============================
// RELOADLY AUTH
// ===============================
async function getReloadlyToken() {
if (reloadlyToken) return reloadlyToken;

const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: AUTH_AUDIENCE
},
{ headers: { "Content-Type": "application/json" } }
);

reloadlyToken = res.data.access_token;
console.log("🔐 Reloadly authentifié");
return reloadlyToken;
}

// ===============================
// SHOPIFY WEBHOOK
// ===============================
app.post("/webhook", async (req, res) => {
try {
const order = req.body;
const orderId = order.id;

let phone = null;

if (order.note_attributes) {
const field = order.note_attributes.find(
f => f.name.toLowerCase().includes("num")
);
if (field) phone = field.value;
}

if (!phone) {
console.log("❌ Numéro reçu null");
return res.status(400).send("Numéro manquant");
}

pendingRecharges[orderId] = {
phone,
amount: order.total_price,
currency: order.currency || "USD"
};

console.log("✅ WEBHOOK SHOPIFY REÇU");
console.log("🧾 Commande ID :", orderId);
console.log("📱 Numéro :", phone);
console.log("⏸️ Recharge en attente");

res.sendStatus(200);
} catch (err) {
console.error("❌ Erreur webhook :", err.message);
res.sendStatus(500);
}
});

// ===============================
// LISTE RECHARGES À CONFIRMER
// ===============================
app.get("/pending-recharges", (req, res) => {
res.json(pendingRecharges);
});

// ===============================
// CONFIRMATION MANUELLE
// ===============================
app.get("/confirm/:orderId", async (req, res) => {
try {
const data = pendingRecharges[req.params.orderId];
if (!data) return res.status(404).send("Commande introuvable");

const token = await getReloadlyToken();

// 1️⃣ Détection opérateur
const operatorRes = await axios.get(
`${TOPUP_BASE}/operators/auto-detect/phone/${data.phone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/json"
}
}
);

const operatorId = operatorRes.data.operatorId;
console.log("📡 Opérateur détecté :", operatorRes.data.name);

// 2️⃣ Recharge
const topupRes = await axios.post(
`${TOPUP_BASE}/topups`,
{
operatorId,
amount: Number(data.amount),
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: data.phone.replace("509", "")
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

delete pendingRecharges[req.params.orderId];

console.log("✅ Recharge effectuée :", topupRes.data.transactionId);
res.json({ success: true, transaction: topupRes.data });

} catch (err) {
console.error("❌ Erreur recharge :", err.response?.data || err.message);
res.status(500).send("Erreur recharge");
}
});

// ===============================
// ROOT
// ===============================
app.get("/", (req, res) => {
res.send("✅ Reloadly Shopify Server actif");
});

// ===============================
app.listen(PORT, () =>
console.log("🚀 Serveur lancé sur port", PORT)
);
