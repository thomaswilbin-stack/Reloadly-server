import express from "express";
import axios from "axios";
import sgMail from "@sendgrid/mail";
import twilio from "twilio";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// =====================
// CONFIG RELOADLY
// =====================
const RELOADLY_ENV = process.env.RELOADLY_ENV || "sandbox";
const RELOADLY_BASE =
RELOADLY_ENV === "production"
? "https://topups.reloadly.com"
: "https://topups-sandbox.reloadly.com";

let reloadlyToken = null;

// =====================
// EMAIL / SMS CONFIG
// =====================
if (process.env.SENDGRID_API_KEY) {
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const twilioClient =
process.env.TWILIO_ACCOUNT_SID &&
process.env.TWILIO_AUTH_TOKEN
? twilio(
process.env.TWILIO_ACCOUNT_SID,
process.env.TWILIO_AUTH_TOKEN
)
: null;

// =====================
// AUTH RELOADLY
// =====================
async function getReloadlyToken() {
if (reloadlyToken) return reloadlyToken;

const res = await axios.post(
"https://auth.reloadly.com/oauth/token",
{
client_id: process.env.RELOADLY_CLIENT_ID,
client_secret: process.env.RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: RELOADLY_BASE
},
{ headers: { "Content-Type": "application/json" } }
);

reloadlyToken = res.data.access_token;
return reloadlyToken;
}

// =====================
// DÉTECTION OPÉRATEUR
// =====================
async function detectOperator(phone) {
const token = await getReloadlyToken();

const res = await axios.get(
`${RELOADLY_BASE}/operators/auto-detect/phone/${phone}/countries/HT`,
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/json"
}
}
);

return res.data;
}

// =====================
// STOCKAGE
// =====================
const pendingRecharges = [];

// =====================
// WEBHOOK SHOPIFY
// =====================
app.post("/webhook", async (req, res) => {
try {
const order = req.body;
const item = order.line_items[0];

const phoneProp = item.properties?.find(p =>
p.name.toLowerCase().includes("num")
);

const phone = phoneProp?.value;
const amount = parseFloat(item.price);

if (!phone || !amount) return res.sendStatus(200);

const operator = await detectOperator(phone);

pendingRecharges.push({
orderId: order.id,
orderNumber: order.order_number,
phone,
amount,
operatorId: operator.operatorId,
operatorName: operator.name,
email: order.email,
customerPhone: order.phone,
status: "PENDING"
});

console.log("⏸️ Recharge en attente :", order.id);
res.sendStatus(200);
} catch (err) {
console.error(err.message);
res.sendStatus(200);
}
});

// =====================
// LISTE ADMIN
// =====================
app.get("/pending-recharges", (req, res) => {
res.json(pendingRecharges.filter(r => r.status === "PENDING"));
});

// =====================
// CONFIRMER RECHARGE
// =====================
app.get("/confirm/:orderId", async (req, res) => {
const recharge = pendingRecharges.find(
r => r.orderId == req.params.orderId
);

if (!recharge) {
return res.status(404).send("Commande introuvable");
}

try {
const token = await getReloadlyToken();

await axios.post(
`${RELOADLY_BASE}/topups`,
{
operatorId: recharge.operatorId,
amount: recharge.amount,
recipientPhone: {
countryCode: "HT",
number: recharge.phone.replace("+509", "")
}
},
{
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/com.reloadly.topups-v1+json",
"Content-Type": "application/json"
}
}
);

recharge.status = "COMPLETED";

// =====================
// MESSAGE CLIENT
// =====================
const message = `✅ Recharge réussie !
Opérateur : ${recharge.operatorName}
Numéro : ${recharge.phone}
Montant : ${recharge.amount} CAD
Merci pour votre confiance.`;

// EMAIL
if (recharge.email && process.env.SENDGRID_API_KEY) {
await sgMail.send({
to: recharge.email,
from: process.env.EMAIL_FROM,
subject: "Recharge mobile effectuée avec succès",
text: message
});
}

// SMS
if (recharge.customerPhone && twilioClient) {
await twilioClient.messages.create({
body: message,
from: process.env.TWILIO_PHONE_NUMBER,
to: recharge.customerPhone
});
}

res.json({ success: true });
} catch (err) {
console.error(err.response?.data || err.message);
res.status(500).send("Erreur recharge");
}
});

// =====================
app.get("/", (req, res) => {
res.send("🚀 Serveur Reloadly actif");
});

app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
