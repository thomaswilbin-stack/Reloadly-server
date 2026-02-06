const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

// middleware JSON
app.use(express.json());

app.get("/", (req, res) => {
res.send("Reloadly server running");
});

app.post("/webhook/shopify-paid", (req, res) => {
console.log("🔥 WEBHOOK SHOPIFY REÇU 🔥");
console.log("Body:", req.body);
res.status(200).send("OK");
});

app.listen(PORT, () => {
console.log("🚀 Serveur actif sur port", PORT);
});
