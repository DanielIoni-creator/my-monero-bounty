const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');
const { createWebhookModule } = require('./webhooks');

const app = express();
const PORT = 8080;

app.use(express.json()); // bodies for the admin webhook CRUD routes

console.log('🚀 Avvio Mongo Proxy...');

// Credenziali e IP corretto
const MONGO_USER = 'admin';
const MONGO_PASS = '5Tz1FIrvGyoKfOT5Z1pe';
const MONGO_IP = '172.18.0.2';

const url = `mongodb://${MONGO_USER}:${MONGO_PASS}@${MONGO_IP}:27017/myzubster?authSource=admin`;

const client = new MongoClient(url);
let db;

async function connectDB() {
    try {
        await client.connect();
        db = client.db('myzubster');
        console.log('✅ Connesso a MongoDB');
        // Test: conta i token
        const count = await db.collection('tokens').countDocuments();
        console.log(`📊 Trovati ${count} token`);
    } catch (err) {
        console.error('❌ Errore MongoDB:', err.message);
    }
}
connectDB();

// --- Webhook system for order events (bounty #5) ---
// Mounts the admin CRUD router at /api/admin/webhooks and exposes an order-event
// dispatcher on app.locals.webhooks.dispatchOrderEvent for the order lifecycle.
// The webhook store connects via an env-driven Mongo URI (WEBHOOK_MONGO_URI /
// MONGO_URI); the pre-existing connection block above is left untouched. Connects
// non-blocking and degrades gracefully if the DB is unavailable.
const orderWebhooks = createWebhookModule(mongoose, { base: '/api/admin/webhooks' });
orderWebhooks.attach(app);
const webhookMongoUri = process.env.WEBHOOK_MONGO_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/myzubster';
orderWebhooks.connect(webhookMongoUri)
  .then(() => console.log('✅ Webhook store connesso a MongoDB'))
  .catch((err) => console.error('⚠️ Webhook store MongoDB non disponibile:', err.message));

app.use('/static', express.static(path.join(__dirname, 'static')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/api/tokens', async (req, res) => {
    try {
        if (!db) {
            await connectDB();
        }
        const tokens = await db.collection('tokens').find({}).toArray();
        res.json(tokens);
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
    console.log(`🔔 Webhook admin: http://localhost:${PORT}/api/admin/webhooks`);
});
