const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================= RAW BODY SHOPIFY ================= */
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

/* ================= DATABASE ================= */

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

/* ================= VERIFY SHOPIFY HMAC ================= */

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

if (order.financial_status !== "paid") {
return res.status(200).send("Non payé");
}

// 🔍 Trouver produit recharge par NOM
const rechargeItem = order.line_items.find(item =>
item.title && item.title.toUpperCase().includes("RECHARGE")
);

if (!rechargeItem) {
console.log("Produit recharge non trouvé");
return res.status(200).send("Pas recharge");
}

const checkoutId = order.checkout_id || order.id;

/* ================= EXTRACTION TELEPHONE ================= */

let phone = null;

if (order.note_attributes && order.note_attributes.length > 0) {
const phoneField = order.note_attributes.find(attr =>
attr.name.toLowerCase().includes("phone")
);
if (phoneField) phone = phoneField.value;
}

if (!phone) {
console.log("Téléphone non trouvé dans note_attributes");
return res.status(400).send("Téléphone manquant");
}

// Nettoyage numéro (enlève espaces, +, -, etc.)
phone = phone.replace(/\D/g, "");

if (phone.length < 8) {
console.log("Numéro invalide:", phone);
return res.status(400).send("Numéro invalide");
}

const amount = parseFloat(rechargeItem.price);

if (!amount || amount <= 0) {
console.log("Montant invalide");
return res.status(400).send("Montant invalide");
}

const countryCode = "HT"; // ⚠️ adapte si multi pays

console.log("Checkout:", checkoutId);
console.log("Phone:", phone);
console.log("Amount:", amount);

/* ================= ANTI DOUBLE RECHARGE ================= */

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

/* ================= ENVOI RELOADLY ================= */

try {
const token = await getReloadlyToken();

const operatorId = await detectOperator(phone, countryCode, token);

await pool.query(
`UPDATE recharges SET operator_id=$1 WHERE checkout_id=$2`,
[operatorId, checkoutId]
);

const response = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: false,
customIdentifier: checkoutId,
recipientPhone: {
countryCode,
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

console.log("Recharge SUCCESS:", response.data);

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

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log("Wimas server running on port " + PORT);
});
