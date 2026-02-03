const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => {
res.send("Serveur Reloadly actif ✅");
});

app.post("/webhook", (req, res) => {
const order = req.body;
const items = order.line_items || [];
const properties = items[0]?.properties || [];

let phone = "";
let country = "";
let amount = items[0]?.price || "";

properties.forEach(p => {
if (p.name === "Numéro à recharger") phone = p.value;
if (p.name === "Pays") country = p.value;
});

console.log("📦 Nouvelle commande reçue");
console.log("📱 Numéro :", phone);
console.log("🌍 Pays :", country);
console.log("💰 Montant :", amount);

res.status(200).send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log("🚀 Serveur lancé sur le port", PORT);
});