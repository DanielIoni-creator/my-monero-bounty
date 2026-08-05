const express = require('express');
const path = require('path');
const i18n = require('./i18n');
const app = express();
const PORT = 8080;

console.log('🚀 Avvio Simple Server...');

// i18n middleware: resolves req.locale and provides req.t() for every request.
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
                'Accept-Language': req.headers['accept-language'] || 'en'
            }
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(503).json({ error: req.t('errors.upstreamError', { detail: error.message }) });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
});
