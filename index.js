const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

/* ================= RAW BODY ================= */
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/", (req, res) => {
res.status(200).send("Wimas Reloadly Server en ligne 🚀");
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

await pool.query(`
ALTER TABLE recharges
ADD COLUMN IF NOT EXISTS operator_id INTEGER;
`);

console.log("PostgreSQL prêt");
})();

/* ================= HMAC VERIFY ================= */

function verifyShopifyWebhook(req) {
try {
const hmac = req.get("X-Shopify-Hmac-Sha256");

const digest = crypto
.createHmac("sha256", SHOPIFY_SECRET)
.update(req.body)
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(hmac),
Buffer.from(digest)
);
} catch {
return false;
}
}

/* ================= TOKEN ================= */

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

/* ================= OPERATOR DETECT ================= */

async function detectOperator(phone, countryCode, token) {
const response = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/${countryCode}`,
{
headers: { Authorization: `Bearer ${token}` }
}
);

if (!response.data?.operatorId) {
throw new Error("Opérateur non détecté");
}

return response.data.operatorId;
}

/* ================= PHONE EXTRACT ================= */

function extractPhone(order, rechargeItem) {
let phone = null;

if (rechargeItem.properties?.length > 0) {
const prop = rechargeItem.properties.find(p =>
p.value && p.value.match(/\d{6,}/)
);
if (prop) phone = prop.value;
}

if (!phone && order.note_attributes?.length > 0) {
const attr = order.note_attributes.find(a =>
a.value && a.value.match(/\d{6,}/)
);
if (attr) phone = attr.value;
}

if (!phone && order.shipping_address?.phone) {
phone = order.shipping_address.phone;
}

if (!phone && order.customer?.phone) {
phone = order.customer.phone;
}

return phone ? phone.replace(/\D/g, "") : null;
}

/* ================= WEBHOOK ================= */

app.post("/webhook", async (req, res) => {

if (!verifyShopifyWebhook(req)) {
return res.status(401).send("HMAC invalide");
}

const order = JSON.parse(req.body.toString());

if (order.financial_status !== "paid") {
return res.status(200).send("Non payé");
}

const rechargeItem = order.line_items.find(item =>
item.title?.toUpperCase().includes("RECHARGE")
);

if (!rechargeItem) {
return res.status(200).send("Pas recharge");
}

const checkoutId = order.checkout_id || order.id;
const amount = parseFloat(rechargeItem.price);
const phone = extractPhone(order, rechargeItem);
const countryCode = "HT";

if (!checkoutId || !amount || !phone) {
return res.status(400).send("Données invalides");
}

/* 🚀 Répond immédiatement à Shopify */
res.status(200).send("OK");

try {

/* ================= ANTI DOUBLE ================= */

const existing = await pool.query(
`SELECT status FROM recharges WHERE checkout_id=$1`,
[checkoutId]
);

if (existing.rows.length > 0) {
if (existing.rows[0].status === "success") {
console.log("Déjà traité");
return;
}
} else {
await pool.query(
`INSERT INTO recharges (checkout_id, phone, amount, status)
VALUES ($1,$2,$3,'processing')`,
[checkoutId, phone, amount]
);
}

/* ================= RELOADLY ================= */

const token = await getReloadlyToken();
const operatorId = await detectOperator(phone, countryCode, token);

await pool.query(
`UPDATE recharges SET operator_id=$1 WHERE checkout_id=$2`,
[operatorId, checkoutId]
);

await axios.post(
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
}
}
);

await pool.query(
`UPDATE recharges SET status='success'
WHERE checkout_id=$1`,
[checkoutId]
);

console.log("Recharge SUCCESS:", checkoutId);

} catch (err) {

await pool.query(
`UPDATE recharges SET status='failed'
WHERE checkout_id=$1`,
[checkoutId]
);

console.log("Erreur recharge:", err.response?.data || err.message);
}

});

/* ================= PORT ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log("Server running on port " + PORT);
});

