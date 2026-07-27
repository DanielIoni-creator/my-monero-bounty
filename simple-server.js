const express = require('express');
const path = require('path');
const { i18nMiddleware } = require('./middleware/i18n');
const app = express();
const PORT = 8080;

console.log('🚀 Avvio Simple Server...');

// i18n middleware - detects language from Accept-Language header
app.use(i18nMiddleware);

app.use('/static', express.static(path.join(__dirname, 'static')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Language detection endpoint
app.get('/api/lang', (req, res) => {
    res.json({
        language: req.language,
        supported: ['en', 'zh', 'ms', 'ta']
    });
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
        const msg = req.t('proxy_error', error.message);
        res.status(500).json({ error: msg });
    }
});

// 404 handler with i18n
app.use((req, res) => {
    res.status(404).json({ error: req.t('not_found') });
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
    console.log(`🌐 i18n: ${['en', 'zh', 'ms', 'ta'].join(', ')} supported`);
});
