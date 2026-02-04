import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

/* ==============================
VARIABLES ENV (RENDER)
================================ */
const RELOADLY_CLIENT_ID = process.env.RELOADLY_CLIENT_ID;
const RELOADLY_CLIENT_SECRET = process.env.RELOADLY_CLIENT_SECRET;
const RELOADLY_ENV = process.env.RELOADLY_ENV || "sandbox"; // sandbox | production

const RELOADLY_AUTH_URL =
RELOADLY_ENV === "production"
? "https://auth.reloadly.com/oauth/token"
: "https://auth.reloadly.com/oauth/token";

const RELOADLY_TOPUP_URL =
RELOADLY_ENV === "production"
? "https://topups.reloadly.com/topups"
: "https://topups.reloadly.com/topups";

/* ==============================
STOCKAGE EN MÉMOIRE (simple)
================================ */
const pendingRecharges = [];

/* ==============================
AUTH RELOADLY (INTERNE)
================================ */
async function getReloadlyToken() {
const res = await axios.post(RELOADLY_AUTH_URL, {
client_id: RELOADLY_CLIENT_ID,
client_secret: RELOADLY_CLIENT_SECRET,
grant_type: "client_credentials",
audience: "https://topups.reloadly.com"
});

return res.data.access_token;
}

/* ==============================
WEBHOOK SHOPIFY
================================ */
app.post("/webhook", async (req, res) => {
console.log("✅ WEBHOOK SHOPIFY REÇU");

const order = req.body;

const phone =
order.note_attributes?.find(f => f.name === "Numero a recharger")?.value ||
null;

const amount = parseFloat(order.total_price);

console.log("📱 Numéro reçu :", phone);
console.log("💰 Montant reçu :", amount);

if (!phone || isNaN(amount) || amount <= 0) {
console.log("❌ Données invalides");
return res.status(400).send("Invalid data");
}

pendingRecharges.push({
orderId: order.id,
phone,
amount,
email: order.email,
status: "PENDING"
});

console.log("⏸️ Recharge en attente (semi-auto)");
res.send("OK");
});

/* ==============================
VOIR COMMANDES EN ATTENTE
================================ */
app.get("/pending-recharges", (req, res) => {
res.json(pendingRecharges.filter(r => r.status === "PENDING"));
});

/* ==============================
CONFIRMER RECHARGE
================================ */
app.get("/confirm/:orderId", async (req, res) => {
const recharge = pendingRecharges.find(
r => r.orderId == req.params.orderId
);

if (!recharge) {
return res.status(404).send("Commande introuvable");
}

try {
const token = await getReloadlyToken();

const response = await axios.post(
RELOADLY_TOPUP_URL,
{
recipientPhone: {
countryCode: "HT",
number: recharge.phone.replace("+509", "")
},
amount: recharge.amount,
operatorId: 173 // Digicel Haiti (à adapter si besoin)
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

console.log("✅ Recharge exécutée");
res.json({
success: true,
reloadly: response.data
});
} catch (err) {
console.error("❌ Erreur recharge", err.response?.data || err.message);
res.status(500).json(err.response?.data || err.message);
}
});

/* ==============================
TEST SERVEUR
================================ */
app.get("/", (req, res) => {
res.send("🚀 Serveur Reloadly actif");
});

app.listen(PORT, () => {
console.log(`🚀 Serveur actif sur port ${PORT}`);
});
