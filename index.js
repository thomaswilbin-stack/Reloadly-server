const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// =========================
// VARIABLES MÉMOIRE (SEMI-AUTO)
// =========================
let derniereCommande = null;
let reloadlyToken = null;

// =========================
// TEST SERVEUR
// =========================
app.get("/", (req, res) => {
res.send("✅ Reloadly server running (semi-automatique)");
});

// =========================
// WEBHOOK SHOPIFY
// =========================
app.post("/webhook", (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");

const orderId = req.body.id;
const items = req.body.line_items || [];
let numeroRecharge = null;
let montantRecharge = null;

items.forEach(item => {
// 💰 Prix du produit = montant recharge
montantRecharge = parseFloat(item.price);

// 📱 Champ personnalisé
if (item.properties) {
item.properties.forEach(prop => {
if (prop.name === "Numéro à recharger") {
numeroRecharge = prop.value;
}
});
}
});

console.log("🧾 Commande :", orderId);
console.log("📱 Numéro :", numeroRecharge);
console.log("💰 Montant :", montantRecharge);

if (
!numeroRecharge ||
!numeroRecharge.startsWith("509") ||
!montantRecharge
) {
console.log("❌ Données invalides");
return res.sendStatus(200);
}

// Stockage temporaire (semi-auto)
derniereCommande = {
orderId,
numeroRecharge,
montantRecharge
};

console.log("⏸️ Recharge en attente (semi-auto)");
res.sendStatus(200);
});

// =========================
// AUTHENTIFICATION RELOADLY
// =========================
app.get("/auth-reloadly", async (req, res) => {
try {
const response = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
}
);

reloadlyToken = response.data.access_token;

console.log("🔐 Token Reloadly obtenu");
res.send("✅ Auth Reloadly réussie");
} catch (err) {
console.error("❌ Erreur auth Reloadly", err.response?.data || err.message);
res.status(500).send("Erreur Reloadly auth");
}
});

// =========================
// RECHARGE RÉELLE (SEMI-AUTO)
// =========================
app.get("/recharge", async (req, res) => {
try {
if (!derniereCommande) {
return res.send("❌ Aucune recharge en attente");
}

if (!reloadlyToken) {
return res.send("❌ Reloadly non authentifié");
}
// 👉 OPÉRATEUR
const operatorId = 173; // 173 = Digicel Haiti | 174 = Natcom Haiti

console.log("🚀 Lancement recharge");
console.log("📱 Numéro :", derniereCommande.numeroRecharge);
console.log("💰 Montant :", derniereCommande.montantRecharge);

const response = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId: operatorId,
amount: derniereCommande.montantRecharge,
useLocalAmount: false,
recipientPhone: {
countryCode: "HT",
number: derniereCommande.numeroRecharge
}
},
{
headers: {
Authorization: `Bearer ${reloadlyToken}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json"
}
}
);

console.log("✅ RECHARGE EFFECTUÉE :", response.data);

// 🔒 Anti double recharge
derniereCommande = null;

res.send("🎉 Recharge effectuée avec succès");
} catch (err) {
console.error("❌ Erreur recharge", err.response?.data || err.message);
res.status(500).send("Erreur lors de la recharge");
}
});

// =========================
// LANCEMENT SERVEUR
// =========================
app.listen(PORT, () => {
console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
