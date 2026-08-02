const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { createWebhookModule } = require('./webhooks');
const { createMiddleware } = require('./i18n');

const app = express();
const PORT = process.env.PORT || 8080;

console.log('🚀 Avvio Mongo Proxy...');

// i18n (closes issue #22): must run before any route so handlers can
// read req.locale and call req.t(...). Mounted after express.json so
// body parsers get the raw payload first.
app.use(express.json({ limit: '1mb' }));
app.use(createMiddleware());

// Webhook system (closes issue #5). Mounts:
//   - admin CRUD at /api/admin/webhooks
//   - order-event dispatcher on app.locals.webhooks.dispatchOrderEvent
//
// The webhook module reads its own Mongo URI from WEBHOOK_MONGO_URI /
// The legacy tokens connection below is left untouched.
const webhookModule = createWebhookModule(null, { uri: process.env.WEBHOOK_MONGO_URI || process.env.MONGO_URI });
webhookModule
  .attach(app)
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
        // Issue #22: return a localized internal error.
        res.status(500).json({
            error: 'internal_error',
            message: req.t('api.tokens.list_failed'),
            locale: req.locale,
        });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: req.t('api.health.ok'), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
    console.log(`🔔 Webhooks: http://localhost:${PORT}/api/admin/webhooks`);
});
