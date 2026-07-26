const express = require('express');
const path = require('path');
const app = express();
const PORT = 8080;

console.log('🚀 Avvio Simple Server...');

// Servi i file statici
app.use('/static', express.static(path.join(__dirname, 'static')));

// Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Proxy per le API (use invece di get per gestire tutti i metodi)
app.use('/api', async (req, res) => {
    try {
        const target = `http://localhost:3001${req.url}`;
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
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/health', async (req, res) => {
    try {
        const response = await fetch('http://localhost:3001/health');
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.json({ status: 'error', message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Server avviato su http://localhost:${PORT}`);
    console.log(`📄 Dashboard: http://localhost:${PORT}`);
    console.log(`📡 API: http://localhost:${PORT}/api/tokens`);
});
