const express = require("express");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3000;

// 👉 IMPORTANT : parser JSON pour Shopify
app.use(bodyParser.json());

// ✅ Route test (pour vérifier que le serveur est en ligne)
app.get("/", (req, res) => {
res.send("✅ Reloadly server is running");
});

// ✅ Webhook Shopify (paiement de commande)
app.post("/webhook", async (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");

try {
// ID de la commande
const orderId = req.body.id;
console.log("🧾 Commande ID :", orderId);

// Récupérer les produits
const items = req.body.line_items || [];
let numeroRecharge = null;

// Chercher le champ personnalisé
items.forEach(item => {
if (item.properties && Array.isArray(item.properties)) {
item.properties.forEach(prop => {
if (prop.name === "Numéro à recharger") {
numeroRecharge = prop.value;
}
});
}
});

console.log("📱 Numéro à recharger :", numeroRecharge);

// Vérifications de sécurité
if (!numeroRecharge) {
console.log("❌ Aucun numéro trouvé dans la commande");
return res.sendStatus(200);
}

if (!numeroRecharge.startsWith("509")) {
console.log("❌ Numéro invalide (doit commencer par 509)");
return res.sendStatus(200);
}

// 👉 MODE SEMI-AUTOMATIQUE (pour l’instant)
console.log("🔄 Recharge prête à être lancée (semi-automatique)");
console.log("⏸️ Recharge NON exécutée automatiquement");

// TODO PLUS TARD :
// - appeler l’API Reloadly ici
// - empêcher double recharge
// - logger la transaction

res.sendStatus(200);
} catch (error) {
console.error("❌ Erreur webhook :", error);
res.sendStatus(500);
}
});

// ✅ Lancer le serveur
app.listen(PORT, () => {
console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
