const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================= RAW BODY POUR SHOPIFY ================= */
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => {
res.status(200).send("Wimas Reloadly Server en ligne 🚀");
});

app.get("/webhook", (req, res) => {
res.status(200).send("Webhook endpoint actif");
});

/* ================= ENV ================= */

const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

/* ================= POSTGRES ================= */

const pool = new Pool({
connectionString: DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

(async () => {
await pool.query(`
CREATE TABLE IF NOT EXISTS recharges (
id SERIAL PRIMARY KEY,
checkout_id TEXT UNIQUE NOT NULL,
phone TEXT NOT NULL,
amount NUMERIC NOT NULL,
status TEXT NOT NULL,
operator_id INTEGER,
created_at TIMESTAMP DEFAULT NOW()
);
`);
console.log("PostgreSQL prêt");
})();

/* ================= VERIFY HMAC ================= */

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

/* ================= RELOADLY TOKEN ================= */

async function getReloadlyToken() {
const response = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
}
);
return response.data.access_token;
}

/* ================= AUTO DETECT OPERATOR ================= */

async function detectOperator(phone, countryCode, token) {
const response = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/${countryCode}`,
{
headers: { Authorization: `Bearer ${token}` }
}
);

if (!response.data || !response.data.operatorId) {
throw new Error("Opérateur non détecté");
}

return response.data.operatorId;
}

/* ================= WEBHOOK ================= */

app.post("/webhook", async (req, res) => {
console.log("Webhook reçu");

if (!verifyShopifyWebhook(req)) {
console.log("HMAC invalide");
return res.status(401).send("HMAC invalide");
}

const order = JSON.parse(req.body.toString());

console.log("Financial status:", order.financial_status);

if (order.financial_status !== "paid") {
return res.status(200).send("Non payé");
}

// ✅ IDENTIFICATION PAR NOM PRODUIT
const rechargeItem = order.line_items.find(item =>
item.title && item.title.toUpperCase().includes("RECHARGE")
);

if (!rechargeItem) {
console.log("Produit recharge non trouvé");
return res.status(200).send("Pas recharge");
}

const checkoutId = order.checkout_id;
const phone = order.note?.trim();
const amount = parseFloat(rechargeItem.price);

if (!checkoutId || !phone || !amount) {
console.log("Données invalides");
return res.status(400).send("Données invalides");
}

const countryCode = "HT"; // change si multi pays

const client = await pool.connect();

try {
await client.query("BEGIN");

const insert = await client.query(
`INSERT INTO recharges (checkout_id, phone, amount, status)
VALUES ($1,$2,$3,'processing')
ON CONFLICT (checkout_id) DO NOTHING
RETURNING *`,
[checkoutId, phone, amount]
);

if (insert.rowCount === 0) {
console.log("Recharge déjà traitée - BLOQUÉE");
await client.query("ROLLBACK");
return res.status(200).send("Déjà traité");
}

await client.query("COMMIT");

} catch (err) {
await client.query("ROLLBACK");
console.log("Erreur DB:", err.message);
return res.status(500).send("Erreur DB");
} finally {
client.release();
}

try {
const token = await getReloadlyToken();

const operatorId = await detectOperator(phone, countryCode, token);

await pool.query(
`UPDATE recharges SET operator_id=$1 WHERE checkout_id=$2`,
[operatorId, checkoutId]
);

const topupResponse = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId: operatorId,
amount: amount,
useLocalAmount: false,
customIdentifier: checkoutId,
recipientPhone: {
countryCode: countryCode,
number: phone
}
},
{
headers: {
Authorization: `Bearer ${token}`,
"Content-Type": "application/json"
},
timeout: 15000
}
);

await pool.query(
`UPDATE recharges SET status='success'
WHERE checkout_id=$1`,
[checkoutId]
);

console.log("Recharge SUCCESS:", topupResponse.data);

} catch (err) {

await pool.query(
`UPDATE recharges SET status='failed'
WHERE checkout_id=$1`,
[checkoutId]
);

console.log("Erreur recharge:", err.response?.data || err.message);
}

return res.status(200).send("OK");
});

/* ================= PORT ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log("Wimas server running on port " + PORT);
});
