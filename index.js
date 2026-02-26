require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;

// ======================
// POSTGRESQL
// ======================

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl:
process.env.NODE_ENV === "production"
? { rejectUnauthorized: false }
: false
});

pool.connect()
.then(() => console.log("✅ PostgreSQL prêt"))
.catch(err => console.error("❌ Erreur PostgreSQL", err));

// ======================
// TOKEN RELOADLY
// ======================

let reloadlyToken = null;
let tokenExpiry = null;

async function getReloadlyToken() {
if (reloadlyToken && tokenExpiry && Date.now() < tokenExpiry) {
return reloadlyToken;
}

const response = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
},
{ headers: { "Content-Type": "application/json" } }
);

reloadlyToken = response.data.access_token;
tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

console.log("🔑 Nouveau token Reloadly obtenu");
return reloadlyToken;
}

// ======================
// NORMALISATION TELEPHONE
// ======================

function normalizePhone(phone) {
if (!phone) return null;

phone = phone.replace(/[\s\-()]/g, "");
if (phone.startsWith("+")) phone = phone.substring(1);
if (phone.startsWith("509")) phone = phone.substring(3);

return phone;
}

// ======================
// EXTRACTION ULTRA ROBUSTE
// ======================

function extractPhone(order) {

// 1️⃣ line item properties
if (order.line_items) {
for (let item of order.line_items) {
if (item.properties) {
for (let prop of item.properties) {
if (prop.value && prop.value.match(/\d{8}/)) {
return prop.value;
}
}
}
}
}

// 2️⃣ note attributes
if (order.note_attributes) {
for (let attr of order.note_attributes) {
if (attr.value && attr.value.match(/\d{8}/)) {
return attr.value;
}
}
}

// 3️⃣ fallback
if (order.customer?.phone) return order.customer.phone;
if (order.shipping_address?.phone) return order.shipping_address.phone;
if (order.billing_address?.phone) return order.billing_address.phone;

return null;
}

// ======================
// AUTO DETECT OPERATOR
// ======================

async function detectOperator(phone, token) {
const response = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/HT`,
{ headers: { Authorization: `Bearer ${token}` } }
);
return response.data.operatorId;
}

// ======================
// VALIDATION BUNDLE
// ======================

async function validateBundleAmount(operatorId, amount, token) {
const response = await axios.get(
`https://topups.reloadly.com/operators/${operatorId}`,
{ headers: { Authorization: `Bearer ${token}` } }
);

const operator = response.data;
if (!operator.denominations) {
throw new Error("Montants indisponibles");
}

const allowed = operator.denominations.map(d => parseFloat(d));
if (!allowed.includes(parseFloat(amount))) {
throw new Error("Montant non autorisé pour ce plan");
}

return true;
}

// ======================
// FULFILLMENT SHOPIFY
// ======================

async function markOrderAsFulfilled(orderId) {
await axios.post(
`https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}/fulfillments.json`,
{
fulfillment: { notify_customer: true }
},
{
headers: {
"X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
"Content-Type": "application/json"
}
}
);

console.log("📦 Fulfilled + email envoyé");
}

// ======================
// WEBHOOK SHOPIFY
// ======================

app.post(
"/webhook",
express.raw({ type: "application/json" }),
async (req, res) => {
try {

const hmac = req.headers["x-shopify-hmac-sha256"];
const digest = crypto
.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
.update(req.body)
.digest("base64");

if (hmac !== digest) {
console.log("❌ Webhook invalide");
return res.sendStatus(401);
}

const order = JSON.parse(req.body.toString());
console.log("📩 Webhook reçu");

if (order.financial_status !== "paid") {
console.log("⏳ Commande non payée");
return res.sendStatus(200);
}

const orderId = order.id;

let phone = extractPhone(order);
phone = normalizePhone(phone);

console.log("📞 Téléphone:", phone);

if (!phone || !phone.match(/^\d{8}$/)) {
console.log("❌ Numéro invalide");
return res.sendStatus(200);
}

const amount = parseFloat(order.line_items[0].price);
const title = order.line_items[0].title.toUpperCase();

const token = await getReloadlyToken();

let operatorId;

if (title.includes("NATCOM")) {
operatorId = 1296;
console.log("📡 Plan Natcom");
} else if (title.includes("DIGICEL")) {
operatorId = 1297;
console.log("📡 Plan Digicel");
} else {
operatorId = await detectOperator(phone, token);
console.log("📱 Recharge normale");
}

console.log("📡 Operator:", operatorId);
console.log("💵 Montant:", amount);

if (operatorId === 1296 || operatorId === 1297) {
await validateBundleAmount(operatorId, amount, token);
}

const existing = await pool.query(
"SELECT 1 FROM recharges WHERE order_id = $1",
[orderId]
);

if (existing.rows.length > 0) {
console.log("⚠ Déjà traité");
return res.sendStatus(200);
}

await pool.query(
"INSERT INTO recharges (order_id, phone, amount, status) VALUES ($1,$2,$3,$4)",
[orderId, phone, amount, "pending"]
);

await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: true,
recipientPhone: { countryCode: "HT", number: phone }
},
{ headers: { Authorization: `Bearer ${token}` } }
);

await pool.query(
"UPDATE recharges SET status = $1 WHERE order_id = $2",
["success", orderId]
);

await markOrderAsFulfilled(orderId);

console.log("✅ Recharge réussie");
res.sendStatus(200);

} catch (error) {
console.error("❌ Erreur:", error.response?.data || error.message);
res.sendStatus(200);
}
}
);

// ======================
// ROUTE TEST
// ======================

app.get("/", (req, res) => {
res.send("🚀 Wimas Reloadly Server en ligne");
});

app.listen(PORT, () => {
console.log(`🚀 Wimas server running on port ${PORT}`);
});
