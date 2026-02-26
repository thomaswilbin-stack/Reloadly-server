require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ======================
// POSTGRESQL
// ======================

const pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

pool.connect()
.then(() => console.log("PostgreSQL prêt"))
.catch(err => console.error("Erreur PostgreSQL", err));

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

console.log("Nouveau token Reloadly obtenu");

return reloadlyToken;
}

// ======================
// AUTO DETECT OPERATOR
// ======================

async function detectOperator(phone, token) {

const response = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/HT`,
{
headers: { Authorization: `Bearer ${token}` }
}
);

return response.data.operatorId;
}

// ======================
// VALIDATION BUNDLE
// ======================

async function validateBundleAmount(operatorId, amount, token) {

const response = await axios.get(
`https://topups.reloadly.com/operators/${operatorId}`,
{
headers: { Authorization: `Bearer ${token}` }
}
);

const operator = response.data;

if (!operator.denominations) {
throw new Error("Impossible de récupérer les montants");
}

const allowedAmounts = operator.denominations.map(d => parseFloat(d));

if (!allowedAmounts.includes(parseFloat(amount))) {
throw new Error("Montant non autorisé pour ce plan");
}

return true;
}

// ======================
// EXTRACTION TELEPHONE
// ======================

function extractPhone(order) {

if (order.note_attributes) {
for (let attr of order.note_attributes) {
if (attr.name.toLowerCase().includes("phone")) {
return attr.value;
}
}
}

if (order.line_items) {
for (let item of order.line_items) {
if (item.properties) {
for (let prop of item.properties) {
if (prop.name.toLowerCase().includes("phone")) {
return prop.value;
}
}
}
}
}

return null;
}

// ======================
// FULFILLMENT SHOPIFY
// ======================

async function markOrderAsFulfilled(orderId) {

await axios.post(
`https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}/fulfillments.json`,
{
fulfillment: {
notify_customer: true
}
},
{
headers: {
"X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
"Content-Type": "application/json"
}
}
);

console.log("Commande marquée Fulfilled + email envoyé");
}

// ======================
// WEBHOOK SHOPIFY
// ======================

app.post("/webhook", async (req, res) => {

try {

const order = req.body;

if (order.financial_status !== "paid") {
return res.sendStatus(200);
}

const orderId = order.id;
const phone = extractPhone(order);

if (!phone) {
console.log("Téléphone non trouvé");
return res.sendStatus(200);
}

const amount = parseFloat(order.line_items[0].price);
const title = order.line_items[0].title.toUpperCase();

const token = await getReloadlyToken();

let operatorId;

if (title.includes("NATCOM")) {
operatorId = 1296;
console.log("Plan Natcom détecté");
}
else if (title.includes("DIGICEL")) {
operatorId = 1297;
console.log("Plan Digicel détecté");
}
else {
operatorId = await detectOperator(phone, token);
console.log("Recharge normale détectée");
}

if (operatorId === 1296 || operatorId === 1297) {
await validateBundleAmount(operatorId, amount, token);
}

const existing = await pool.query(
"SELECT * FROM recharges WHERE order_id = $1",
[orderId]
);

if (existing.rows.length > 0) {
console.log("Recharge déjà traitée");
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
recipientPhone: {
countryCode: "HT",
number: phone
}
},
{
headers: { Authorization: `Bearer ${token}` }
}
);

await pool.query(
"UPDATE recharges SET status = $1 WHERE order_id = $2",
["success", orderId]
);

await markOrderAsFulfilled(orderId);

res.sendStatus(200);

} catch (error) {

console.error("Erreur recharge :", error.message);
res.sendStatus(200);
}

});

// ======================
// ROOT TEST
// ======================

app.get("/", (req, res) => {
res.send("Wimas Reloadly Server en ligne 🚀");
});

app.listen(PORT, () => {
console.log(`Wimas server running on port ${PORT}`);
});
