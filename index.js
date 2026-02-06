import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 10000;

// ⚠️ middleware global JSON
app.use(express.json());

app.post("/webhook/shopify-paid", (req, res) => {
console.log("🔥🔥🔥 WEBHOOK SHOPIFY REÇU 🔥🔥🔥");
console.log("Headers:", req.headers);
console.log("Body:", req.body);

return res.status(200).send("OK");
});

app.get("/", (req, res) => {
res.send("Reloadly server running");
});
