const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// =======================
// IMPORTANT POUR SHOPIFY
// =======================
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// =======================
// ROUTES TEST
// =======================
app.get("/", (req, res) => {
res.status(200).send("Wimas Reloadly Server en ligne 🚀");
});

// Pour éviter "Cannot GET /webhook"
app.get("/webhook", (req, res) => {
res.status(200).send("Webhook endpoint actif");
});

// =======================
// ENV VARIABLES
// =======================
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// =======================
// POSTGRESQL
// =======================
const pool = new Pool({
connectionString: DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

(async () => {
try {
await pool.query(`
CREATE TABLE IF NOT EXISTS recharges (
id SERIAL PRIMARY KEY,
checkout_id TEXT UNIQUE NOT NULL,
phone TEXT NOT NULL,
amount NUMERIC NOT NULL,
status TEXT NOT NULL,
created_at TIMESTAMP DEFAULT NOW()
);
`);
console.log("PostgreSQL prêt");
} catch (err) {
console.log("Erreur DB:", err.message);
}
})();

// =======================
// VERIFY HMAC
// =======================
function verifyShopifyWebhook(req) {
try {
const hmac = req.get("X-Shopify-Hmac-Sha256");

const digest = crypto
.createHmac("sha256", SHOPIFY_SECRET)
.update(req.body, "utf8")
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(hmac),
Buffer.from(digest)
);
} catch {
return false;
}
}

// =======================
// WEBHOOK POST
// =======================
app.post("/webhook", async (req, res) => {
console.log("Webhook reçu");

if (!verifyShopifyWebhook(req)) {
console.log("HMAC invalide");
return res.status(401).send("HMAC invalide");
}

const order = JSON.parse(req.body.toString());

if (order.financial_status !== "paid") {
return res.status(200).send("Non payé");
}

console.log("Commande payée détectée");

return res.status(200).send("Webhook traité");
});

// =======================
// PORT RENDER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log("Wimas server running on port " + PORT);
});
