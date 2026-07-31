const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { createWebhookModule } = require('./webhooks');
const { InMemoryDeliveryLog } = require('./services/deliveryLog');
const { buildAdminAuth } = require('./services/adminAuth');

const app = express();
const PORT = process.env.PORT || 8080;

console.log('🚀 Avvio Mongo Proxy...');

// Webhook system (issue #5 baseline + issue #21 additive features):
//   - admin CRUD at /api/admin/webhooks
//   - per-webhook delivery log at /api/admin/webhooks/:id/deliveries
//   - operator-facing test endpoint at /api/admin/webhooks/:id/test
//   - Bearer-token admin auth (required in production when
//     WEBHOOK_ADMIN_TOKEN / WEBHOOK_ADMIN_TOKENS is configured)
//
// The webhook module reads its own Mongo URI from WEBHOOK_MONGO_URI /
// MONGO_URI. The legacy tokens connection below is left untouched.
app.use(express.json({ limit: '1mb' }));
const deliveryLog = new InMemoryDeliveryLog();
const adminAuth = buildAdminAuth();
const webhookModule = createWebhookModule(null, { uri: process.env.WEBHOOK_MONGO_URI || process.env.MONGO_URI });
webhookModule
  .attach(app, { deliveryLog, adminAuth })
  .catch((err) => console.error('⚠️ Webhook module failed to attach:', err && err.message ? err.message : err));

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
    console.log(`🔔 Webhooks: http://localhost:${PORT}/api/admin/webhooks`);
});
