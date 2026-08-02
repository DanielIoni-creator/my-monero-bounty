const express = require('express');
const path = require('path');
const { createMiddleware } = require('./i18n');
const app = express();
const PORT = 8080;

console.log('🚀 Avvio Simple Server...');

// i18n: detect locale from Accept-Language and attach req.t(req).
// Closes issue #22.
app.use(createMiddleware());

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
                'Content-Type': 'application/json'
            }
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('❌ Error:', error.message);
        // Issue #22: surface a localized upstream/downstream error.
        const upstream = req.t('errors.upstream_unavailable');
        res.status(502).json({
            error: 'upstream_unavailable',
            message: upstream,
            locale: req.locale,
        });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
});
