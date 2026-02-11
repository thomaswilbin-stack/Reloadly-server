app.get("/", (req, res) => {
res.send("Wimas Reloadly Server en ligne 🚀");
});
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// =====================
// ENV VARIABLES
// =====================
const SHOPIFY_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

// =====================
// POSTGRES CONNECTION
// =====================
const pool = new Pool({
connectionString: DATABASE_URL,
ssl: { rejectUnauthorized: false }
});

// =====================
// CREATE TABLE
// =====================
(async () => {
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
})();

// =====================
// VERIFY SHOPIFY HMAC
// =====================
function verifyShopifyWebhook(req) {
const hmac = req.get("X-Shopify-Hmac-Sha256");
const digest = crypto
.createHmac("sha256", SHOPIFY_SECRET)
.update(JSON.stringify(req.body), "utf8")
.digest("base64");

if (!hmac) return false;

return crypto.timingSafeEqual(
Buffer.from(hmac),
Buffer.from(digest)
);
}

// =====================
// GET RELOADLY TOKEN
// =====================
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

// =====================
// WEBHOOK
// =====================
app.post("/webhook", async (req, res) => {

if (!verifyShopifyWebhook(req)) {
return res.status(401).send("HMAC invalide");
}

const order = req.body;

if (order.financial_status !== "paid") {
return res.status(200).send("Non payé");
}

// =====================
// IDENTIFIER PRODUIT RECHARGE
// =====================
const rechargeItem = order.line_items.find(item =>
item.title.toLowerCase().includes("recharge")
);

if (!rechargeItem) {
console.log("Commande ignorée (pas recharge)");
return res.status(200).send("Pas recharge");
}

const checkoutId = order.checkout_id;
const amount = parseFloat(rechargeItem.price);
const phone = (order.note || "").replace(/\D/g, "");

if (!checkoutId || !phone || !amount) {
return res.status(400).send("Données invalides");
}

const client = await pool.connect();

try {
await client.query("BEGIN");

// 🔒 Vérifie si déjà traité
const existing = await client.query(
"SELECT status FROM recharges WHERE checkout_id = $1 FOR UPDATE",
[checkoutId]
);

if (existing.rows.length > 0) {
await client.query("ROLLBACK");
return res.status(200).send("Déjà traité");
}

// 🔒 Protection 5 minutes même numéro
const recent = await client.query(
`SELECT id FROM recharges
WHERE phone = $1
AND created_at > NOW() - INTERVAL '5 minutes'`,
[phone]
);

if (recent.rows.length > 0) {
await client.query("ROLLBACK");
return res.status(200).send("Bloqué 5 minutes");
}

// 🔐 Idempotency key
const idempotencyKey = crypto
.createHash("sha256")
.update(checkoutId + phone + amount)
.digest("hex");

// Insert processing
await client.query(
`INSERT INTO recharges (checkout_id, phone, amount, status)
VALUES ($1, $2, $3, $4)`,
[checkoutId, phone, amount, "processing"]
);

await client.query("COMMIT");

// =====================
// RELOADLY CALL
// =====================
const token = await getReloadlyToken();

const operator = await axios.get(
`https://topups.reloadly.com/operators/auto-detect/phone/${phone}/countries/HT`,
{
headers: { Authorization: `Bearer ${token}` },
timeout: 15000
}
);

const operatorId = operator.data.operatorId;

await axios.post(
"https://topups.reloadly.com/topups",
{
operatorId,
amount,
useLocalAmount: false,
customIdentifier: idempotencyKey,
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

await pool.query(
"UPDATE recharges SET status = $1 WHERE checkout_id = $2",
["success", checkoutId]
);

return res.status(200).send("Recharge OK");

} catch (error) {

await client.query("ROLLBACK");

await pool.query(
"UPDATE recharges SET status = $1 WHERE checkout_id = $2",
["failed", checkoutId]
);

console.log("Erreur recharge:", error.message);

return res.status(200).send("Erreur gérée");
} finally {
client.release();
}
});

// =====================
app.listen(3000, () => {
console.log("Serveur PostgreSQL Wimas démarré");
});

