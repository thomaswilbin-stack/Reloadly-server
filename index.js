const express = require("express");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// =========================
// TEST SERVEUR
// =========================
app.get("/", (req, res) => {
res.send("✅ Reloadly server is running (semi-auto)");
});

// =========================
// WEBHOOK SHOPIFY
// =========================
let derniereCommande = null;

app.post("/webhook", (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");

const orderId = req.body.id;
console.log("🧾 Commande ID :", orderId);

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

console.log("📱 Numéro à recharger :", numeroRecharge);

if (!numeroRecharge || !numeroRecharge.startsWith("509")) {
console.log("❌ Numéro invalide ou manquant");
return res.sendStatus(200);
}

// 👉 On stocke la commande (semi-auto)
derniereCommande = {
orderId,
numeroRecharge
};

console.log("⏸️ Recharge en attente (semi-automatique)");
res.sendStatus(200);
});

// =========================
// DÉCLENCHEMENT MANUEL
// =========================
app.get("/recharge", async (req, res) => {
if (!derniereCommande) {
return res.send("❌ Aucune recharge en attente");
}

console.log("🚀 LANCEMENT MANUEL DE LA RECHARGE");
console.log("📱 Numéro :", derniereCommande.numeroRecharge);
console.log("🧾 Commande :", derniereCommande.orderId);

// 🔜 PLUS TARD :
// appel API Reloadly ici

res.send(
`✅ Recharge prête pour ${derniereCommande.numeroRecharge} (commande ${derniereCommande.orderId})`
);
  });

// =========================
// LANCEMENT SERVEUR
// =========================
app.listen(PORT, () => {
console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
  
