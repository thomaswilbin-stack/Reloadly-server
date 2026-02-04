const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// ================= CONFIG =================
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_ENV = "production"; // production ou sandbox
const OPERATOR_ID = 173; // Digicel Haiti (change si besoin)

let reloadlyToken = null;

// ================= AUTH RELOADLY =================
async function getReloadlyToken() {
try {
const res = await axios.post(
`https://auth.reloadly.com/oauth/token`,
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
console.log("🔐 Token Reloadly obtenu");
} catch (err) {
console.log("❌ Erreur auth Reloadly", err.response?.data || err.message);
}
}

// ================= TEST SERVER =================
app.get("/", (req, res) => {
res.send("✅ Serveur Reloadly actif");
});

// ================= WEBHOOK SHOPIFY =================
app.post("/webhook", async (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");

try {
const order = req.body;
const items = order.line_items || [];
const properties = items[0]?.properties || [];

let phone = "";
let amount = items[0]?.price || 0;

properties.forEach((p) => {
if (p.name === "Numéro à recharger") phone = p.value;
});

console.log("📱 Numéro reçu :", phone);
console.log("💰 Montant :", amount);

// ===== FORMATAGE NUMÉRO (OBLIGATOIRE) =====
phone = phone.toString().trim();
if (!phone.startsWith("+")) {
phone = "+" + phone;
}

console.log("📱 Numéro formaté :", phone);

// Validation Haiti
if (!phone.match(/^\+509\d{8}$/)) {
console.log("❌ Numéro invalide");
return res.status(400).send("Numéro invalide");
}

console.log("⏸️ Recharge prête (semi-auto)");
res.sendStatus(200);

// ================= LANCEMENT MANUEL (SEMI-AUTO) =================
// 👉 Quand TU veux lancer la recharge, décommente ce bloc

/*
if (!reloadlyToken) {
await getReloadlyToken();
}

console.log("🚀 Lancement recharge");

const recharge = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId: OPERATOR_ID,
amount: Number(amount),
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

console.log("✅ Recharge réussie", recharge.data);
*/
} catch (err) {
console.log("❌ Erreur webhook", err.response?.data || err.message);
}
});

// ================= START SERVER =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
console.log(`🚀 Serveur lancé sur port ${PORT}`);
});
