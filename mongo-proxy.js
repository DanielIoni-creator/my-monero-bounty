const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");
const mongoose = require("mongoose");
const webhookRoutes = require("./routes/webhooks");

const app = express();
const PORT = process.env.PORT || 8080;

console.log("🚀 Avvio Mongo Proxy...");

// JSON parser middleware
app.use(express.json());

// Credenziali e IP corretto
const MONGO_USER = process.env.MONGO_USER || "admin";
const MONGO_PASS = process.env.MONGO_PASS || "5Tz1FIrvGyoKfOT5Z1pe";
const MONGO_IP = process.env.MONGO_IP || "172.18.0.2";

const url =
  process.env.MONGO_URI ||
  `mongodb://${MONGO_USER}:${MONGO_PASS}@${MONGO_IP}:27017/myzubster?authSource=admin`;

const client = new MongoClient(url);
let db;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("myzubster");
    console.log("✅ Connesso a MongoDB (MongoClient)");
    const count = await db.collection("tokens").countDocuments();
    console.log(`📊 Trovati ${count} token`);
  } catch (err) {
    console.error("❌ Errore MongoClient:", err.message);
  }
}
connectDB();

// Mongoose Connection
mongoose
  .connect(url)
  .then(() => {
    console.log("✅ Mongoose connesso a MongoDB");
  })
  .catch((err) => {
    console.error("❌ Errore Mongoose:", err.message);
  });

// Admin Webhook Routes
app.use("/api/admin/webhooks", webhookRoutes);

app.use("/static", express.static(path.join(__dirname, "static")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "static", "index.html"));
});

app.get("/api/tokens", async (req, res) => {
  try {
    if (!db) {
      await connectDB();
    }
    const tokens = await db.collection("tokens").find({}).toArray();
    res.json(tokens);
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
    console.log(
      `🔔 Webhook Admin API: http://localhost:${PORT}/api/admin/webhooks`,
    );
  });
}

module.exports = app;
