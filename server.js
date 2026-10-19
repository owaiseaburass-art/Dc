const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Ensure config file exists
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2));
}

// Health check endpoint for Render monitoring & keep-alive
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// API: Get Saved Settings
app.get('/api/config', (req, res) => {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            return res.json(JSON.parse(data || '{}'));
        }
        res.json({});
    } catch (err) {
        console.error('Error reading config:', err);
        res.status(500).json({ error: 'Failed to read config' });
    }
});

// API: Auto-Save Settings
app.post('/api/config', (req, res) => {
    try {
        const newConfig = req.body || {};
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf8');
        res.json({ success: true, message: 'Settings auto-saved successfully' });
    } catch (err) {
        console.error('Error writing config:', err);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Default route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Render] SpyHub Sniper listening on port ${PORT}`);
});
