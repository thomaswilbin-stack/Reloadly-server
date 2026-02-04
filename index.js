// =======================
// CONFIG DE BASE
// =======================
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// =======================
// VARIABLES ENV (Render)
// =======================
const {
RELOADLY_CLIENT_ID,
RELOADLY_CLIENT_SECRET,
RELOADLY_ENV, // sandbox | production
} = process.env;

const RELOADLY_AUTH_URL =
RELOADLY_ENV === "production"
? "https://auth.reloadly.com/oauth/token"
: "https://auth.reloadly.com/oauth/token";

const RELOADLY_API_URL =
RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com";

// =======================
// TEST SERVEUR
// =======================
app.get("/", (req, res) => {
res.send("✅ Serveur Reloadly actif");
});

// =======================
// TOKEN RELOADLY
// =======================
async function getReloadlyToken() {
const res = await axios.post(RELOADLY_AUTH_URL, {
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: RELOADLY_API_URL,
});

console.log("🔐 Token Reloadly obtenu");
return res.data.access_token;
}

// =======================
// WEBHOOK SHOPIFY
// =======================
app.post("/webhook", async (req, res) => {
try {
console.log("✅ WEBHOOK SHOPIFY REÇU");

const order = req.body;
const items = order.line_items || [];
const properties = items[0]?.properties || [];

// =======================
// NUMÉRO À RECHARGER
// =======================
let phone = null;

properties.forEach(p => {
if (p.name.toLowerCase().includes("numéro")) {
phone = p.value;
}
});

if (!phone) {
console.log("❌ Numéro manquant");
return res.status(400).send("Numéro manquant");
}

// Nettoyage numéro Haiti
phone = phone.replace(/\s/g, "");
if (!phone.startsWith("+509")) {
phone = "+509" + phone.replace(/^509/, "");
}

console.log("📱 Numéro reçu :", phone);

// =======================
// MONTANT (LOGIQUE ROBUSTE)
// =======================
let amount = null;

// 1️⃣ Champ personnalisé
properties.forEach(p => {
if (p.name.toLowerCase().includes("montant")) {
amount = parseFloat(p.value);
}
});

// 2️⃣ Prix produit
if (!amount && items[0]?.price) {
amount = parseFloat(items[0].price);
}

// 3️⃣ Total commande
if (!amount && order.total_price) {
amount = parseFloat(order.total_price);
}

if (!amount || isNaN(amount) || amount <= 0) {
console.log("❌ Montant invalide");
return res.status(400).send("Montant invalide");
}

console.log("💰 Montant reçu :", amount);

// =======================
// INFOS CLIENT
// =======================
const customerEmail = order.email || null;
const customerPhone = order.phone || null;
const orderId = order.name;
// =======================
// MODE SEMI-AUTO
// =======================
console.log("⏸️ Recharge en attente (semi-auto)");
console.log("🧾 Commande :", orderId);

// 👉 ICI TU CONFIRMES MANUELLEMENT
// quand tu veux passer en auto, décommente ci-dessous

/*
const token = await getReloadlyToken();

const response = await axios.post(
`${RELOADLY_API_URL}/topups`,
{
recipientPhone: {
countryCode: "HT",
number: phone.replace("+509", ""),
},
amount: amount,
operatorId: 173, // Digicel Haiti (à adapter)
currencyCode: "CAD",
},
{
headers: {
Authorization: `Bearer ${token}`,
"Content-Type": "application/json",
},
}
);

console.log("🚀 Recharge exécutée :", response.data.transactionId);
*/

// =======================
// CONFIRMATION CLIENT
// =======================
if (customerEmail) {
console.log("📧 Confirmation prévue par email :", customerEmail);
}

if (customerPhone) {
console.log("📱 Confirmation prévue par SMS :", customerPhone);
}

return res.status(200).send("OK");
} catch (err) {
console.error("❌ Erreur webhook :", err.response?.data || err.message);
return res.status(500).send("Erreur serveur");
}
});

// =======================
// LANCEMENT SERVEUR
// =======================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
