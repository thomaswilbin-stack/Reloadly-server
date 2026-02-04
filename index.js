const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// ================== CONFIG ==================
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_ENV = "production"; // production ou sandbox

let reloadlyToken = null;

// ================== AUTH RELOADLY ==================
async function getReloadlyToken() {
const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience:
RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com",
}
);

reloadlyToken = res.data.access_token;
console.log("🔐 Reloadly authentifié");
}

// ================== AUTO-DETECT OPERATOR ==================
async function detectOperator(phone) {
if (!reloadlyToken) await getReloadlyToken();

const res = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}`,
{
headers: { Authorization: `Bearer ${reloadlyToken}` },
}
);

console.log("📡 Opérateur détecté :", res.data.name);
return res.data;
}
// ================== TEST ==================
app.get("/", (req, res) => {
res.send("✅ Serveur Reloadly actif");
});

// ================== WEBHOOK SHOPIFY ==================
app.post("/webhook", async (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");

try {
const order = req.body;
const item = order.line_items[0];
const properties = item.properties || [];

let phone = "";
let amount = "";

properties.forEach(p => {
if (p.name === "Numéro à recharger") phone = p.value;
if (p.name === "Montant Recharge") amount = p.value;
});

console.log("📱 Numéro reçu :", phone);
console.log("💰 Montant reçu :", amount);

// ===== FORMAT NUMÉRO =====
phone = phone.toString().trim();
if (!phone.startsWith("+")) phone = "+" + phone;

if (!phone.match(/^\+509\d{8}$/)) {
console.log("❌ Numéro invalide");
return res.status(400).send("Numéro invalide");
}

amount = Number(amount);
if (!amount || amount < 1) {
console.log("❌ Montant invalide");
return res.status(400).send("Montant invalide");
}

console.log("📱 Numéro formaté :", phone);
console.log("💰 Montant validé :", amount);

// ===== AUTO-DETECTION OPÉRATEUR =====
const operator = await detectOperator(phone);
const operatorId = operator.operatorId;

console.log("✅ Operator ID utilisé :", operatorId);
console.log("⏸️ Recharge prête (semi-automatique)");

// ===== SEMI-AUTO (PAS ENCORE EXÉCUTÉ) =====
// 👉 Pour passer FULL AUTO, décommente le bloc ci-dessous

/*
if (!reloadlyToken) await getReloadlyToken();

const recharge = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId: operatorId,
amount: amount,
recipientPhone: {
countryCode: "HT",
number: phone,
},
},
{
headers: {
Authorization: `Bearer ${reloadlyToken}`,
"Content-Type": "application/json",
},
}
);

console.log("✅ Recharge effectuée", recharge.data);
*/

res.sendStatus(200);

} catch (err) {
console.log("❌ Erreur webhook", err.response?.data || err.message);
res.sendStatus(500);
}
});

// ================== START ==================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
