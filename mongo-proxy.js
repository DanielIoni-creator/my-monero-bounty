const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const { createWebhookModule } = require('./webhooks');
const i18n = require('./i18n');

const app = express();
const PORT = process.env.PORT || 8080;

console.log('🚀 Avvio Mongo Proxy...');

// Webhook system (closes issue #5). Mounts:
//   - admin CRUD at /api/admin/webhooks
//   - order-event dispatcher on app.locals.webhooks.dispatchOrderEvent
//
// The webhook module reads its own Mongo URI from WEBHOOK_MONGO_URI /
// MONGO_URI. The legacy tokens connection below is left untouched.
app.use(express.json({ limit: '1mb' }));
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
        const count = await db.collection('tokens').countDocuments();
        console.log(`📊 Trovati ${count} token`);
    } catch (err) {
        console.error('❌ Errore MongoDB:', err.message);
    }
}
connectDB();

// i18n middleware (closes issue #7): resolves req.locale and provides req.t()
// for every request. Registered after the webhook module (webhook routes do
// not need localization) and before the public routes so /api/tokens and
// /api/health can use req.t().
app.use(i18n.i18nMiddleware);

app.use('/static', express.static(path.join(__dirname, 'static')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/api/tokens', async (req, res) => {
    try {
        if (!db) {
            await connectDB();
        }
        if (!db) {
            return res.status(503).json({ error: req.t('errors.serviceUnavailable') });
        }
        const tokens = await db.collection('tokens').find({}).toArray();
        if (!tokens || tokens.length === 0) {
            return res.status(404).json({ message: req.t('tokens.notFound'), tokens: [] });
        }
        res.json({ message: req.t('tokens.listRetrieved'), tokens });
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: req.t('errors.dbConnection', { detail: error.message }) });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: req.t('health.name'), message: req.t('health.ok'), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
    console.log(`🔔 Webhooks: http://localhost:${PORT}/api/admin/webhooks`);
});
