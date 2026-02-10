import express from "express";
import crypto from "crypto";

const app = express();

/* ===========================
CONFIG
=========================== */

const PORT = process.env.PORT || 3000;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

/* ===========================
RAW BODY POUR SHOPIFY
=========================== */

app.post(
"/webhook/paid",
express.raw({ type: "application/json" }),
(req, res) => {
console.log("🔥 WEBHOOK PAYÉ REÇU");

try {
/* ===========================
1. VÉRIFICATION SIGNATURE
============================ */

const hmac = req.headers["x-shopify-hmac-sha256"];
const body = req.body.toString("utf8");

const hash = crypto
.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
.update(body)
.digest("base64");

if (hash !== hmac) {
console.error("❌ Signature Shopify invalide");
return res.status(401).send("Unauthorized");
}

/* ===========================
2. PARSE COMMANDE
============================ */

const order = JSON.parse(body);

console.log("🧾 Order ID:", order.id);
console.log("💰 Total:", order.total_price);

/* ===========================
3. PRODUIT RECHARGE UNIQUEMENT
============================ */

const rechargeItem = order.line_items.find(item =>
item.tags?.includes("RECHARGE") ||
item.title?.toUpperCase().includes("RECHARGE")
);

if (!rechargeItem) {
console.log("⏭️ Pas un produit RECHARGE");
return res.status(200).send("Ignored");
}

console.log("💳 Produit RECHARGE détecté:", rechargeItem.title);

/* ===========================
4. NUMÉRO TÉLÉPHONE
============================ */

const phoneRaw =
order.note_attributes?.find(n => n.name === "phone")?.value ||
order.shipping_address?.phone ||
order.customer?.phone;

if (!phoneRaw) {
console.error("❌ Numéro téléphone introuvable");
return res.status(200).send("No phone");
}

const phoneClean = phoneRaw.replace(/\D/g, "");
console.log("📞 Numéro nettoyé:", phoneClean);

/* ===========================
5. ICI → RELOADLY
============================ */

console.log("🚀 Prêt à envoyer la recharge (Reloadly)");

return res.status(200).send("OK");
} catch (err) {
console.error("❌ ERREUR WEBHOOK:", err);
return res.status(500).send("Server error");
}
}
);

/* ===========================
ROUTE TEST
=========================== */

app.get("/", (req, res) => {
res.send("✅ Wimas webhook server actif");
});

/* ===========================
START SERVER
=========================== */

app.listen(PORT, () => {
console.log(`🚀 Serveur Wimas démarré sur port ${PORT}`);
});
