const express = require("express");
const bodyParser = require("body-parser");

const app = express();

// IMPORTANT : lire le JSON Shopify
app.use(bodyParser.json());

// LOG GLOBAL (très important)
app.use((req, res, next) => {
console.log("Requête reçue :", req.method, req.url);
next();
});

// Route webhook Shopify
app.post("/webhook", (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");
console.log(JSON.stringify(req.body, null, 2));
res.sendStatus(200);
});

// Route test navigateur
app.get("/", (req, res) => {
res.send("Serveur Reloadly actif ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log("Serveur démarré sur le port", PORT);
});
