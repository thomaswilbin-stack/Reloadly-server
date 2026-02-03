const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

let derniereCommande = null;
let reloadlyToken = null;

// =========================
// TEST SERVEUR
// =========================
app.get("/", (req, res) => {
res.send("✅ Reloadly server running (semi-auto)");
});

// =========================
// WEBHOOK SHOPIFY
// =========================
app.post("/webhook", (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");

const orderId = req.body.id;
const items = req.body.line_items || [];
let numeroRecharge = null;

items.forEach(item => {
if (item.properties) {
item.properties.forEach(prop => {
if (prop.name === "Numéro à recharger") {
numeroRecharge = prop.value;
}
});
}
});

if (!numeroRecharge || !numeroRecharge.startsWith("509")) {
console.log("❌ Numéro invalide");
return res.sendStatus(200);
}

derniereCommande = { orderId, numeroRecharge };
console.log("⏸️ Recharge en attente :", numeroRecharge);

res.sendStatus(200);
});

// =========================
// AUTHENTIFICATION RELOADLY
// =========================
app.get("/auth-reloadly", async (req, res) => {
try {
const url =
process.env.RELOADLY_ENV === "production"
? "https://auth.reloadly.com/oauth/token"
: "https://auth.reloadly.com/oauth/token";

const response = await axios.post(url, {
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
});

reloadlyToken = response.data.access_token;

console.log("🔐 Token Reloadly obtenu");
res.send("✅ Auth Reloadly réussie");
} catch (err) {
console.error("❌ Erreur Reloadly auth", err.response?.data || err.message);
res.status(500).send("Erreur Reloadly auth");
}
});

// =========================
// LANCEMENT MANUEL (TEST)
// =========================
app.get("/recharge", (req, res) => {
if (!derniereCommande) {
return res.send("❌ Aucune recharge en attente");
}

if (!reloadlyToken) {
return res.send("❌ Reloadly non authentifié");
}

res.send(
`✅ Prêt à recharger ${derniereCommande.numeroRecharge} (commande ${derniereCommande.orderId})`
);
});

// =========================
// SERVEUR
// =========================
app.listen(PORT, () => {
console.log(`🚀 Serveur démarré sur ${PORT}`);
});
