const express = require('express');
const path = require('path');
const i18n = require('./i18n');
const app = express();
const PORT = 8080;

console.log('🚀 Avvio Simple Server...');

// i18n middleware: sets req.locale + req.t so the proxy response
// strings and the upstream-forwarded Accept-Language header both
// honor the caller's preferred language.
app.use(i18n.i18nMiddleware);

app.use('/static', express.static(path.join(__dirname, 'static')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.use('/api', async (req, res) => {
    try {
        const target = `http://localhost:3001/api${req.url}`;
        console.log(`🔄 ${req.method} ${req.url} → ${target}`);
        const response = await fetch(target, {
            method: req.method,
            headers: {
                'Authorization': req.headers.authorization || '',
                'Content-Type': 'application/json',
                // Forward the resolved locale to the upstream so downstream
                // services can honor the same language preference.
                'Accept-Language': req.locale || i18n.DEFAULT_LOCALE,
            },
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({
            success: false,
            error: req.t('errors.proxyError', { message: error.message }),
        });
    }
});

// 404 fallback for unknown /api routes
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: req.t('errors.notFound') });
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
});
