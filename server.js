const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(__dirname));

// ============================================
// State
// ============================================

let sseClients = [];
let gatewayWs = null;
let heartbeatTimer = null;
let lastSequence = null;
let sessionId = null;
let resumeGatewayUrl = null;
let reconnectAttempts = 0;
let seenCodes = new Set();
let channelNameMap = {};

const state = {
    running: false,
    status: 'IDLE',
    user: null,
    startTime: null,
    lastCopiedCode: '',
    lastCopyTime: 0,
    monitoredChannels: [],
    stats: {
        messages: 0,
        codesCopied: 0
    },
    recentMessages: [],
    recentCodes: []
};

// ============================================
// Config Persistence
// ============================================

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
        }
    } catch (e) {
        console.error('[Config] Read error:', e.message);
    }
    return {};
}

function saveConfig(extra = {}) {
    try {
        const cur = loadConfig();
        const merged = Object.assign({}, cur, extra);
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
        return merged;
    } catch (e) {
        console.error('[Config] Write error:', e.message);
        return extra;
    }
}

// Pre-load persisted stats
try {
    const initialCfg = loadConfig();
    if (initialCfg.stats) {
        state.stats.messages = initialCfg.stats.messages || 0;
        state.stats.codesCopied = initialCfg.stats.codesCopied || initialCfg.stats.codes || 0;
    }
    if (Array.isArray(initialCfg.recentCodes)) {
        state.recentCodes = initialCfg.recentCodes.slice(-30);
    }
} catch (e) {}

// ============================================
// Native Windows Clipboard Injection (clip.exe)
// ============================================

function copyToClipboard(text) {
    if (!text) return false;
    const clean = text.trim();
    state.lastCopiedCode = clean;
    state.lastCopyTime = Date.now();

    try {
        if (process.platform === 'win32') {
            const clip = spawn('clip');
            clip.stdin.write(clean);
            clip.stdin.end();
            clip.on('error', err => console.error('[Clipboard] clip.exe error:', err.message));
            log(`📋 [WIN CLIPBOARD] "${clean}" instantly injected into OS clipboard via clip.exe (0ms)!`, 'success');
        } else {
            log(`📋 [CLIPBOARD] Code captured: "${clean}" (Ready for Ctrl+V)`, 'success');
        }
        return true;
    } catch (e) {
        console.error('[Clipboard] Failed:', e.message);
        return false;
    }
}

// ============================================
// Logging & SSE Push
// ============================================

function log(msg, level = 'info') {
    const ts = new Date().toLocaleTimeString('en-GB');
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
    pushEvent('log', { msg, level, time: ts });
}

function pushEvent(type, data) {
    const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
    sseClients.forEach(res => {
        try {
            res.write(payload);
        } catch (e) {}
    });
}

// ============================================
// 24/7 Discord Gateway Connection
// ============================================

function startGateway() {
    const cfg = loadConfig();
    if (!cfg.token) {
        log('No Discord token configured. Set token in dashboard.', 'error');
        state.status = 'NO_TOKEN';
        pushEvent('status', { status: 'NO_TOKEN' });
        return false;
    }

    const channelIds = (cfg.channelId || '').split(/[\s,]+/).filter(id => id.length > 0);
    if (channelIds.length === 0) {
        log('No channels configured to monitor.', 'error');
        state.status = 'NO_CHANNELS';
        pushEvent('status', { status: 'NO_CHANNELS' });
        return false;
    }

    state.running = true;
    state.status = 'CONNECTING';
    state.startTime = Date.now();
    reconnectAttempts = 0;
    seenCodes.clear();

    const codeRegex = new RegExp(cfg.codeRegex || '\\bSPY-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+\\b', 'gi');
    const presenceStatus = cfg.presenceStatus || 'online';

    log(`🚀 Starting AFK 24/7 Monitor. Watching ${channelIds.length} channel(s)... Status: [${presenceStatus.toUpperCase()}]`);
    pushEvent('status', { status: 'CONNECTING' });

    function connect() {
        if (!state.running) return;

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;

        const endpoint = resumeGatewayUrl || 'wss://gateway.discord.gg/?v=10&encoding=json';
        log(`Connecting to Discord Gateway...`, 'info');

        try {
            gatewayWs = new WebSocket(endpoint);
        } catch (err) {
            log(`Gateway connection error: ${err.message}`, 'error');
            scheduleReconnect();
            return;
        }

        gatewayWs.on('open', () => {
            log('WebSocket established. Awaiting Hello...', 'info');
        });

        gatewayWs.on('message', (rawData) => {
            let msg;
            try {
                msg = JSON.parse(rawData.toString());
            } catch (e) {
                return;
            }

            const { op, d, s, t } = msg;
            if (s !== null && s !== undefined) lastSequence = s;

            switch (op) {
                case 10: { // HELLO
                    const heartbeatInterval = d.heartbeat_interval;
                    log(`Hello received. Heartbeat: ${heartbeatInterval}ms. Sending Identify...`, 'info');

                    // Per Discord docs: first heartbeat after jitter (interval * random())
                    // then fixed interval after that. This matches the official client exactly.
                    const jitter = Math.floor(heartbeatInterval * Math.random());
                    setTimeout(() => {
                        if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                            gatewayWs.send(JSON.stringify({ op: 1, d: lastSequence }));
                        }
                        heartbeatTimer = setInterval(() => {
                            if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                                gatewayWs.send(JSON.stringify({ op: 1, d: lastSequence }));
                            }
                        }, heartbeatInterval);
                    }, jitter);

                    // Send Identify with 24/7 AFK presence
                    gatewayWs.send(JSON.stringify({
                        op: 2,
                        d: {
                            token: cfg.token.trim(),
                            capabilities: 16381,
                            properties: {
                                os: 'Windows',
                                browser: 'Discord Client',
                                release_channel: 'stable',
                                client_version: '1.0.9164',
                                os_version: '10.0.19045',
                                os_arch: 'x64',
                                system_locale: 'en-US',
                                client_build_number: 351426
                            },
                            presence: {
                                status: presenceStatus,
                                since: 0,
                                activities: [],
                                afk: false
                            }
                        }
                    }));
                    break;
                }

                case 1: { // Heartbeat request
                    if (gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                        gatewayWs.send(JSON.stringify({ op: 1, d: lastSequence }));
                    }
                    break;
                }

                case 7: { // Reconnect request
                    log('Gateway requested reconnect.', 'warn');
                    gatewayWs.close(4000);
                    break;
                }

                case 9: { // Invalid session
                    log('Session invalidated. Clearing session and reconnecting...', 'warn');
                    sessionId = null;
                    resumeGatewayUrl = null;
                    lastSequence = null;
                    setTimeout(connect, 3000);
                    break;
                }

                case 0: { // Dispatch
                    if (t === 'READY') {
                        sessionId = d.session_id;
                        resumeGatewayUrl = d.resume_gateway_url;
                        state.user = d.user;
                        state.status = 'ONLINE_24_7';
                        reconnectAttempts = 0;

                        const tag = `${d.user.username}#${d.user.discriminator || '0'}`;
                        log(`✅ ONLINE 24/7 as ${tag} (ID: ${d.user.id})`, 'success');

                        // Map guild channel names
                        channelNameMap = {};
                        if (d.guilds && Array.isArray(d.guilds)) {
                            d.guilds.forEach(g => {
                                if (g.channels && Array.isArray(g.channels)) {
                                    g.channels.forEach(ch => {
                                        if (ch.id && ch.name) channelNameMap[ch.id] = ch.name;
                                    });
                                }
                            });
                        }

                        const names = channelIds.map(id => channelNameMap[id] ? `#${channelNameMap[id]}` : `#${id}`);
                        state.monitoredChannels = names;
                        log(`👀 Monitoring channels: ${names.join(', ')}`, 'info');

                        pushEvent('ready', {
                            user: d.user,
                            channels: names,
                            status: 'ONLINE_24_7',
                            presenceStatus
                        });
                    }

                    if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') {
                        handleIncomingMessage(d, channelIds, codeRegex);
                    }
                    break;
                }
            }
        });

        gatewayWs.on('close', (code) => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = null;

            if (!state.running) {
                state.status = 'IDLE';
                pushEvent('status', { status: 'IDLE' });
                return;
            }

            if (code === 4004) {
                log('❌ Auth failed (4004) — Invalid or expired Discord token! Update token in settings.', 'error');
                state.status = 'AUTH_FAILED';
                state.running = false;
                pushEvent('status', { status: 'AUTH_FAILED' });
                return;
            }

            scheduleReconnect();
        });

        gatewayWs.on('error', (err) => {
            log(`WebSocket error: ${err.message}`, 'error');
        });
    }

    function scheduleReconnect() {
        if (!state.running) return;
        reconnectAttempts++;
        const delay = Math.min(3000 * Math.min(reconnectAttempts, 6), 20000);
        log(`Gateway disconnected. Auto-reconnecting in ${delay / 1000}s... (attempt #${reconnectAttempts})`, 'warn');
        state.status = 'RECONNECTING';
        pushEvent('status', { status: 'RECONNECTING' });
        setTimeout(connect, delay);
    }

    connect();
    return true;
}

function stopGateway() {
    state.running = false;
    state.status = 'IDLE';
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (gatewayWs) {
        try { gatewayWs.close(1000); } catch (e) {}
        gatewayWs = null;
    }
    log('🛑 Gateway stopped. Monitor is IDLE.', 'info');
    pushEvent('status', { status: 'IDLE' });
}

// ============================================
// Message Handling & Code Detection
// ============================================

function handleIncomingMessage(msg, channelIds, codeRegex) {
    if (!msg || !channelIds.includes(msg.channel_id)) return;

    state.stats.messages++;
    const content = msg.content || '';
    const author = msg.author ? (msg.author.username || 'Unknown') : 'Unknown';
    const channelName = channelNameMap[msg.channel_id] ? `#${channelNameMap[msg.channel_id]}` : `#${msg.channel_id}`;
    const timestamp = msg.timestamp || new Date().toISOString();

    // Check for drop triggers / owner announcements
    const dropTriggers = /\b(@here|@everyone|ready\??|get\s*ready|incoming|drop|dropping|giveaway|giftcard|countdown|code\s*drop|posting\s*in)\b/i;
    const isTrigger = dropTriggers.test(content);

    // Save to message buffer
    const msgObj = {
        id: msg.id,
        author,
        content,
        channel: channelName,
        channel_id: msg.channel_id,
        timestamp,
        isTrigger
    };

    state.recentMessages.push(msgObj);
    if (state.recentMessages.length > 80) state.recentMessages.shift();

    // Push to UI terminal
    pushEvent('message', msgObj);

    if (isTrigger) {
        log(`🎯 DROP ALERT in ${channelName} from ${author}: "${content.substring(0, 100)}"`, 'warn');
    }

    // Scan for Codes
    codeRegex.lastIndex = 0;
    const matches = content.match(codeRegex);

    if (matches && matches.length > 0) {
        for (const code of matches) {
            const cleanCode = code.trim().toUpperCase();
            if (seenCodes.has(cleanCode)) continue;
            seenCodes.add(cleanCode);

            state.stats.codesCopied++;
            log(`⚡ CODE DETECTED: "${cleanCode}" from ${author} in ${channelName}`, 'success');

            // 1. INSTANT WIN32 CLIPBOARD INJECTION (0ms)
            copyToClipboard(cleanCode);

            // 2. Save to history
            const codeItem = {
                code: cleanCode,
                author,
                channel: channelName,
                time: new Date().toISOString()
            };
            state.recentCodes.push(codeItem);
            if (state.recentCodes.length > 40) state.recentCodes.shift();

            // 3. Persist stats
            saveConfig({
                stats: state.stats,
                recentCodes: state.recentCodes
            });

            // 4. Push instant event to UI
            pushEvent('code_found', {
                code: cleanCode,
                author,
                channel: channelName,
                content: content.substring(0, 150),
                time: new Date().toLocaleTimeString('en-GB')
            });
        }
    }
}

// ============================================
// REST API Routes
// ============================================

// Get Config
app.get('/api/config', (req, res) => {
    res.json(loadConfig());
});

// Update Config
app.post('/api/config', (req, res) => {
    try {
        const updated = saveConfig(req.body || {});
        log('Config saved.', 'info');
        res.json({ success: true, config: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get Live Status
app.get('/api/status', (req, res) => {
    res.json({
        running: state.running,
        status: state.status,
        user: state.user,
        stats: state.stats,
        lastCopiedCode: state.lastCopiedCode,
        monitoredChannels: state.monitoredChannels,
        recentMessages: state.recentMessages.slice(-40),
        recentCodes: state.recentCodes.slice(-20)
    });
});

// Start/Stop
app.post('/api/sniper/start', (req, res) => {
    startGateway();
    res.json({ success: true, running: state.running, status: state.status });
});

app.post('/api/sniper/stop', (req, res) => {
    stopGateway();
    res.json({ success: true, running: false, status: 'IDLE' });
});

// Test Clipboard Copy
app.post('/api/test-copy', (req, res) => {
    const testCode = req.body?.code || 'SPY-TEST-7777-8888';
    const copied = copyToClipboard(testCode);
    res.json({ success: copied, code: testCode });
});

// SSE Stream for Real-Time UI Updates
app.get('/api/sniper/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    // Initial state packet
    res.write(`data: ${JSON.stringify({
        type: 'init',
        state: {
            running: state.running,
            status: state.status,
            user: state.user,
            stats: state.stats,
            lastCopiedCode: state.lastCopiedCode,
            monitoredChannels: state.monitoredChannels,
            recentMessages: state.recentMessages.slice(-40),
            recentCodes: state.recentCodes.slice(-20)
        }
    })}\n\n`);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

// ============================================
// Server Start & Auto-Run
// ============================================

app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`⚡ Discord Drop Monitor & Clipboard Copier`);
    console.log(`📡 Listening on http://localhost:${PORT}`);
    console.log(`========================================\n`);

    const cfg = loadConfig();
    if (cfg.token && cfg.channelId && cfg.autoStart !== false) {
        log('Auto-starting 24/7 Discord Monitor...', 'info');
        startGateway();
    }
});
