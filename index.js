const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(express.json());

// =============================
// CONFIG
// =============================
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;

// =============================
// SQLITE (PERSISTANT STARTER)
// =============================
const dbPath = path.join(__dirname, "recharges.db");

const db = new sqlite3.Database(dbPath, (err) => {
if (err) {
console.error("Erreur DB:", err);
} else {
console.log("SQLite connecté :", dbPath);
}
});

db.run(`
CREATE TABLE IF NOT EXISTS recharges (
id INTEGER PRIMARY KEY AUTOINCREMENT,
checkout_id TEXT UNIQUE,
phone TEXT,
amount REAL,
status TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

// =============================
// HMAC SHOPIFY VERIFY
// =============================
function verifyShopifyWebhook(req) {
const hmac = req.get("X-Shopify-Hmac-Sha256");
const digest = crypto
.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
.update(JSON.stringify(req.body), "utf8")
.digest("base64");

return crypto.timingSafeEqual(
Buffer.from(hmac || "", "utf8"),
Buffer.from(digest, "utf8")
);
}

// =============================
// GET RELOADLY TOKEN
// =============================
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

// =============================
// WEBHOOK
// =============================
app.post("/webhook", async (req, res) => {

if (!verifyShopifyWebhook(req)) {
return res.status(401).send("HMAC invalide");
}

const order = req.body;

const checkoutId = order.checkout_id;
const amount = parseFloat(order.total_price);
const phoneRaw = order.note || "";
const phone = phoneRaw.replace(/\D/g, "");

if (!checkoutId || !phone || !amount) {
return res.status(400).send("Données invalides");
}

console.log("Nouvelle commande :", checkoutId);

db.serialize(() => {
db.run("BEGIN IMMEDIATE TRANSACTION");

// 1️⃣ Vérifie si checkout déjà existant
db.get(
"SELECT status FROM recharges WHERE checkout_id = ?",
[checkoutId],
async (err, row) => {

if (row) {
console.log("Déjà traité :", checkoutId);
db.run("ROLLBACK");
return res.status(200).send("Déjà traité");
}

// 2️⃣ Protection 10 minutes même phone + montant
db.get(
`SELECT id FROM recharges
WHERE phone = ? AND amount = ?
AND created_at >= datetime('now','-10 minutes')`,
[phone, amount],
async (err2, recent) => {

if (recent) {
console.log("Recharge bloquée (10 min)");
db.run("ROLLBACK");
return res.status(200).send("Doublon 10 min bloqué");
}

// 3️⃣ Insert processing
db.run(
`INSERT INTO recharges (checkout_id, phone, amount, status)
VALUES (?, ?, ?, ?)`,
[checkoutId, phone, amount, "processing"],
async (err3) => {

if (err3) {
console.log("Insert bloqué:", err3.message);
db.run("ROLLBACK");
return res.status(200).send("Insert bloqué");
}

db.run("COMMIT");

try {

const token = await getReloadlyToken();

// Auto detect opérateur
const operator = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/HT`,
{ headers: { Authorization: `Bearer ${token}` } }
);

const operatorId = operator.data.operatorId;

// Timeout sécurité 20 sec
const topup = await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId: operatorId,
amount: amount,
useLocalAmount: false,
customIdentifier: checkoutId,
recipientPhone: {
countryCode: "HT",
number: phone
}
},
{
headers: { Authorization: `Bearer ${token}` },
timeout: 20000
}
);

console.log("Recharge OK:", topup.data.transactionId);

db.run(
"UPDATE recharges SET status = ? WHERE checkout_id = ?",
["success", checkoutId]
);

} catch (error) {

console.log("Erreur recharge:", error.message);

db.run(
"UPDATE recharges SET status = ? WHERE checkout_id = ?",
["failed", checkoutId]
);
}

return res.status(200).send("OK");
}
);
}
);
}
);
});
});

// =============================
app.listen(3000, () => {
console.log("Serveur démarré sur port 3000");
});
