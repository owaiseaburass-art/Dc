const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 10000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Global Crash Prevention (Never crashes under any circumstances)
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught exception prevented server crash:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[CRITICAL] Unhandled rejection prevented server crash:', reason);
});

// Ensure config file exists & load persisted state
if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({}, null, 2));
}

// ============================================
// Shared State
// ============================================

let sniperState = {
    running: false,
    connectedAs: null,
    status: 'IDLE',
    stats: { messages: 0, codes: 0, redeemed: 0, trapsBlocked: 0 },
    recentCodes: [],     // last 50 codes found
    recentEvents: [],    // last 100 log lines
    startTime: null,
    lastSnipeMs: null,   // latency of last snipe attempt
    monitoredChannels: [],
    hotChannel: {
        id: null,
        name: null,
        until: 0,
        reason: null
    }
};

let channelNameMap = {}; // channelId -> channelName

function setHotChannel(channelId, reason) {
    const chName = channelNameMap[channelId] ? `#${channelNameMap[channelId]}` : `#${channelId}`;
    const previous = sniperState.hotChannel?.id;
    sniperState.hotChannel = {
        id: channelId,
        name: chName,
        until: Date.now() + 10 * 60 * 1000, // 10 minutes sticky focus
        reason: reason || 'Drop Trigger'
    };

    if (previous !== channelId) {
        sniperLog(`🔥 [HOT FOCUS] Switched to ${chName} for 10m (${reason}). Still checking all selected channels in parallel.`, 'warn');
    } else {
        sniperLog(`🔥 [HOT FOCUS] Refreshed 10m timer on ${chName} (${reason}).`, 'info');
    }

    pushEvent('hot_channel', sniperState.hotChannel);
}

// Restore persisted stats and codes from config.json if available
try {
    if (fs.existsSync(CONFIG_FILE)) {
        const savedCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
        if (savedCfg.stats) {
            sniperState.stats = Object.assign(sniperState.stats, savedCfg.stats);
        }
        if (savedCfg.recentCodes && Array.isArray(savedCfg.recentCodes)) {
            sniperState.recentCodes = savedCfg.recentCodes;
        }
    }
} catch (e) {
    console.error('[Config] Failed to preload persisted state:', e.message);
}

function persistServerConfig(extra = {}) {
    try {
        let cur = {};
        if (fs.existsSync(CONFIG_FILE)) {
            cur = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
        }
        const merged = Object.assign({}, cur, extra, {
            stats: sniperState.stats,
            recentCodes: sniperState.recentCodes.slice(-50)
        });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
    } catch (e) {
        console.error('[Config] Error persisting server state:', e.message);
    }
}

let sniperWs = null;
let sniperHeartbeat = null;
let sniperLastSeq = null;
let sniperSessionId = null;
let sniperResumeUrl = null;
let sniperReconnectAttempts = 0;
const MAX_RECONNECTS = 10;
let seenCodes = new Set();
let recentMessagesBuffer = []; // for anti-trap context

// SSE clients for live push to browser dashboard
let sseClients = [];

// ============================================
// Utility: Server-Side HTTPS Fetch
// ============================================

function httpsFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const reqOpts = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        const req = https.request(reqOpts, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                resolve({ status: res.statusCode, headers: res.headers, body });
            });
        });

        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ============================================
// Logging / SSE Push
// ============================================

function sniperLog(msg, level = 'info') {
    const ts = new Date().toISOString();
    const entry = { ts, msg, level };
    sniperState.recentEvents.push(entry);
    if (sniperState.recentEvents.length > 100) sniperState.recentEvents.shift();
    console.log(`[${level.toUpperCase()}] ${msg}`);

    // push to all SSE clients
    const data = JSON.stringify({ type: 'log', ...entry });
    for (const client of sseClients) {
        client.write(`data: ${data}\n\n`);
    }
}

function pushEvent(type, payload) {
    const data = JSON.stringify({ type, ...payload });
    for (const client of sseClients) {
        client.write(`data: ${data}\n\n`);
    }
}

// ============================================
// Anti-Trap Detection (server-side mirror)
// ============================================

const TRAP_PATTERNS = [
    /ban\s*(lifetime)?/i,
    /lifetime\s*ban/i,
    /trap/i,
    /fake\s*key/i,
    /dont\s*redeem/i,
    /do\s*not\s*redeem/i,
    /ban\s*code/i,
    /blacklist/i
];

function isTrapContext(content) {
    for (const pat of TRAP_PATTERNS) {
        if (pat.test(content)) return true;
    }
    const recent = recentMessagesBuffer.slice(-3);
    for (const item of recent) {
        for (const pat of TRAP_PATTERNS) {
            if (pat.test(item.content)) return true;
        }
    }
    return false;
}

// ============================================
// Server-Side SpyHub Redeem
// ============================================

async function serverRedeemCode(code, cfg) {
    const snipeStart = Date.now();
    sniperLog(`⚡ Attempting server-side redeem: ${code}`);

    // Try API redeem (no CORS on server!)
    try {
        const headers = {
            'Content-Type': 'application/json',
            'Origin': 'https://spyhub.kdns.fr',
            'Referer': 'https://spyhub.kdns.fr/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
        };
        if (cfg.spyhubCookie) {
            headers['Cookie'] = cfg.spyhubCookie;
        }

        const result = await httpsFetch('https://spyhub-web.spyuhq.workers.dev/api/site/giftcard', {
            method: 'POST',
            headers,
            body: JSON.stringify({ code })
        });

        const elapsed = Date.now() - snipeStart;
        sniperState.lastSnipeMs = elapsed;

        const rawLower = (result.body || '').toLowerCase();
        const isAlreadyRedeemed = rawLower.includes('already redeemed') || 
                                  rawLower.includes('already claimed') || 
                                  rawLower.includes('already used') || 
                                  rawLower.includes('has already been redeemed') ||
                                  rawLower.includes('has been claimed') ||
                                  rawLower.includes('already_redeemed');

        let responseJson = null;
        try { responseJson = JSON.parse(result.body); } catch(e) {}

        const isSuccess = (result.status >= 200 && result.status < 300) && !isAlreadyRedeemed && (!responseJson || responseJson.success !== false);

        if (isSuccess) {
            sniperState.stats.redeemed++;
            sniperLog(`✅ REDEEMED "${code}" in ${elapsed}ms! Response: ${result.body}`, 'success');
            sniperState.recentCodes.push({
                code, status: 'redeemed', time: new Date().toISOString(), ms: elapsed,
                response: result.body.substring(0, 200)
            });
            persistServerConfig();
            pushEvent('redeem', { code, status: 'redeemed', ms: elapsed, response: result.body });
            return { success: true, status: 'redeemed', ms: elapsed };
        } else if (isAlreadyRedeemed) {
            sniperLog(`⚠️ GIFT CARD ALREADY REDEEMED: "${code}" was taken by someone else! (${elapsed}ms)`, 'warn');
            sniperState.recentCodes.push({
                code, status: 'already_redeemed', time: new Date().toISOString(), ms: elapsed,
                response: result.body.substring(0, 200)
            });
            persistServerConfig();
            pushEvent('redeem', { code, status: 'already_redeemed', ms: elapsed, reason: 'Already redeemed by someone else', response: result.body });
            return { success: false, status: 'already_redeemed', ms: elapsed };
        } else {
            sniperLog(`⚠ Redeem returned ${result.status}: ${result.body.substring(0, 200)}`, 'warn');
            sniperState.recentCodes.push({
                code, status: 'failed', time: new Date().toISOString(), ms: elapsed,
                response: result.body.substring(0, 200)
            });
            persistServerConfig();
            pushEvent('redeem', { code, status: 'failed', ms: elapsed, response: result.body });
            return { success: false, status: 'failed', ms: elapsed };
        }
    } catch (err) {
        const elapsed = Date.now() - snipeStart;
        sniperState.lastSnipeMs = elapsed;
        sniperLog(`✗ Redeem error: ${err.message} (${elapsed}ms)`, 'error');
        sniperState.recentCodes.push({
            code, status: 'error', time: new Date().toISOString(), ms: elapsed, error: err.message
        });
        pushEvent('redeem', { code, status: 'error', ms: elapsed, error: err.message });
        return { success: false, status: 'error', ms: elapsed, error: err.message };
    }
}

// ============================================
// Server-Side Discord Gateway Sniper
// ============================================

function startServerSniper() {
    const cfgRaw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(cfgRaw || '{}');

    if (!cfg.token) {
        sniperLog('No token in config. Save settings from the dashboard first.', 'error');
        return false;
    }

    const channelIds = (cfg.channelId || '').split(/[\s,]+/).filter(id => id.length > 0);
    if (channelIds.length === 0) {
        sniperLog('No channel IDs configured.', 'error');
        return false;
    }

    const codeRegex = new RegExp(cfg.codeRegex || '\\bSPY-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+\\b', 'gi');
    const antiTrap = cfg.antiTrap !== false;
    const autoRedeem = cfg.autoRedeem !== false;

    sniperState.running = true;
    sniperState.status = 'CONNECTING';
    sniperState.startTime = Date.now();
    sniperReconnectAttempts = 0;
    seenCodes.clear();
    recentMessagesBuffer = [];

    sniperLog(`Starting server-side sniper. Monitoring ${channelIds.length} channel(s)...`);
    pushEvent('status', { status: 'CONNECTING' });

    function connect() {
        sniperLog('Connecting to Discord Gateway...');
        sniperWs = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

        sniperWs.on('open', () => {
            sniperLog('WebSocket connected, waiting for Hello...');
        });

        sniperWs.on('message', (raw) => {
            const data = JSON.parse(raw.toString());
            const { op, d, s, t } = data;
            if (s) sniperLastSeq = s;

            switch (op) {
                case 10: { // Hello
                    const interval = d.heartbeat_interval;
                    sniperLog(`Hello received. Heartbeat: ${interval}ms`);

                    if (sniperHeartbeat) clearInterval(sniperHeartbeat);
                    setTimeout(() => {
                        if (sniperWs && sniperWs.readyState === WebSocket.OPEN) {
                            sniperWs.send(JSON.stringify({ op: 1, d: sniperLastSeq }));
                        }
                    }, interval * Math.random());
                    sniperHeartbeat = setInterval(() => {
                        if (sniperWs && sniperWs.readyState === WebSocket.OPEN) {
                            sniperWs.send(JSON.stringify({ op: 1, d: sniperLastSeq }));
                        }
                    }, interval);

                    // Identify as user token
                    const identifyPayload = {
                        op: 2,
                        d: {
                            token: cfg.token,
                            capabilities: 16381,
                            properties: {
                                os: 'Windows',
                                browser: 'Chrome',
                                device: '',
                                system_locale: 'en-US',
                                browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                browser_version: '120.0.0.0',
                                os_version: '10',
                                referrer: '',
                                referring_domain: '',
                                referrer_current: '',
                                referring_domain_current: '',
                                release_channel: 'stable',
                                client_build_number: 250484,
                                client_event_source: null
                            },
                            presence: {
                                status: 'invisible',
                                since: 0,
                                activities: [],
                                afk: false
                            },
                            compress: false,
                            client_state: { guild_versions: {} }
                        }
                    };
                    sniperWs.send(JSON.stringify(identifyPayload));
                    sniperLog('Identify sent (user token)...');
                    break;
                }

                case 11: // Heartbeat ACK
                    break;

                case 7: // Reconnect requested
                    sniperLog('Server requested reconnect.', 'warn');
                    sniperWs.close(4000);
                    break;

                case 9: // Invalid session
                    sniperLog('Invalid session. Re-identifying in 3s...', 'warn');
                    setTimeout(() => {
                        if (sniperWs && sniperWs.readyState === WebSocket.OPEN) {
                            const payload = {
                                op: 2,
                                d: {
                                    token: cfg.token,
                                    capabilities: 16381,
                                    properties: {
                                        os: 'Windows', browser: 'Chrome', device: '',
                                        system_locale: 'en-US',
                                        browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
                                        browser_version: '120.0.0.0', os_version: '10',
                                        release_channel: 'stable', client_build_number: 250484
                                    },
                                    presence: { status: 'invisible', since: 0, activities: [], afk: false },
                                    compress: false, client_state: { guild_versions: {} }
                                }
                            };
                            sniperWs.send(JSON.stringify(payload));
                        }
                    }, 3000);
                    break;

                case 0: { // Dispatch
                    if (t === 'READY') {
                        const user = d.user;
                        sniperSessionId = d.session_id;
                        sniperResumeUrl = d.resume_gateway_url;
                        sniperReconnectAttempts = 0;
                        sniperState.connectedAs = `${user.username}#${user.discriminator || '0'}`;
                        sniperState.status = 'CONNECTED';
                        sniperLog(`✅ Connected as ${sniperState.connectedAs}`, 'success');
                        pushEvent('status', { status: 'CONNECTED', user: sniperState.connectedAs });

                        // Resolve channel names
                        let chNames = [];
                        if (d.guilds) {
                            for (const g of d.guilds) {
                                if (g.channels) {
                                    for (const c of g.channels) {
                                        channelNameMap[c.id] = c.name;
                                    }
                                    for (const tid of channelIds) {
                                        const ch = g.channels.find(c => c.id === tid);
                                        if (ch) chNames.push(`#${ch.name}`);
                                    }
                                }
                            }
                        }
                        sniperState.monitoredChannels = chNames.length > 0 ? chNames : channelIds.map(id => '#' + id);
                        if (chNames.length > 0) {
                            sniperLog(`Monitoring: ${chNames.join(', ')}`);
                        }
                        pushEvent('status', { status: 'CONNECTED', user: sniperState.connectedAs, channels: sniperState.monitoredChannels });
                    }

                    if (t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') {
                        handleServerMessage(d, channelIds, codeRegex, antiTrap, autoRedeem, cfg);
                    }
                    break;
                }
            }
        });

        sniperWs.on('close', (code) => {
            if (sniperHeartbeat) clearInterval(sniperHeartbeat);
            sniperHeartbeat = null;

            if (!sniperState.running) return;

            if (code === 4004) {
                sniperLog('Auth failed (4004) — invalid token! Update token in settings.', 'error');
                sniperState.status = 'AUTH_FAILED';
                sniperState.running = false;
                pushEvent('status', { status: 'AUTH_FAILED' });
                return;
            }

            sniperReconnectAttempts++;
            // Reconnect forever with capped backoff (max 25s) — NEVER stop running
            const delay = Math.min(3000 * Math.min(sniperReconnectAttempts, 8), 25000);
            sniperLog(`Gateway disconnected (code ${code}). Auto-reconnecting in ${delay / 1000}s... (attempt #${sniperReconnectAttempts})`, 'warn');
            sniperState.status = 'RECONNECTING';
            pushEvent('status', { status: 'RECONNECTING' });
            setTimeout(connect, delay);
        });

        sniperWs.on('error', (err) => {
            sniperLog(`WebSocket error: ${err.message}`, 'error');
        });
    }

    connect();
    return true;
}

function handleServerMessage(msg, channelIds, codeRegex, antiTrap, autoRedeem, cfg) {
    if (!channelIds.includes(msg.channel_id)) return;

    sniperState.stats.messages++;

    const content = msg.content || '';
    const author = msg.author ? (msg.author.username || 'Unknown') : 'Unknown';
    const channelName = channelNameMap[msg.channel_id] ? `#${channelNameMap[msg.channel_id]}` : `#${msg.channel_id}`;

    // Detect "ready" / ping / drop triggers
    const dropTriggers = /\b(@here|@everyone|ready\??|get\s*ready|incoming|drop|dropping|giveaway|giftcard|countdown|code\s*drop|posting\s*in)\b/i;
    if (dropTriggers.test(content)) {
        const triggerType = content.includes('@everyone') ? '@everyone ping' : content.includes('@here') ? '@here ping' : 'Drop trigger';
        setHotChannel(msg.channel_id, triggerType);
        sniperLog(`🎯 PREFIRE TRIGGER in ${channelName} from ${author}: "${content.substring(0, 80)}"`, 'warn');
        pushEvent('prefire_trigger', { author, content: content.substring(0, 200), channel_id: msg.channel_id, channel_name: channelName });
    }

    // Detect chat messages saying the giftcard was already redeemed / claimed
    const claimedPatterns = /\b(already\s*redeemed|already\s*claimed|already\s*taken|someone\s*(already\s*)?took\s*it|i\s*claimed|i\s*redeemed|i\s*got\s*it|code\s*is\s*redeemed|it['’]s\s*redeemed|already\s*used|too\s*late)\b/i;
    if (claimedPatterns.test(content)) {
        sniperLog(`📢 Chat confirmed code was already claimed/redeemed in ${channelName} from ${author}: "${content.substring(0, 80)}"`, 'warn');
        pushEvent('chat_claimed', { author, content: content.substring(0, 200), channel_id: msg.channel_id, channel_name: channelName });
    }

    // Scan for codes
    codeRegex.lastIndex = 0;
    const matches = content.match(codeRegex);

    if (matches && matches.length > 0) {
        setHotChannel(msg.channel_id, 'Code Drop Detected');

        for (const code of matches) {
            if (seenCodes.has(code)) continue;
            seenCodes.add(code);

            // Anti-trap check
            if (antiTrap && isTrapContext(content)) {
                sniperState.stats.trapsBlocked++;
                sniperLog(`🛡️ TRAP BLOCKED: "${code}" from ${author} in ${channelName} — context: "${content.substring(0, 100)}"`, 'warn');
                pushEvent('trap', { code, author, content: content.substring(0, 200), channel_id: msg.channel_id, channel_name: channelName });
                // still buffer the message
                recentMessagesBuffer.push({ author, content, time: Date.now() });
                if (recentMessagesBuffer.length > 10) recentMessagesBuffer.shift();
                continue;
            }

            sniperState.stats.codes++;
            sniperLog(`⚡ CODE FOUND: ${code} from ${author} in ${channelName}`, 'success');
            pushEvent('code_found', { code, author, content: content.substring(0, 200), channel_id: msg.channel_id, channel_name: channelName });

            if (autoRedeem) {
                // Execute redeem immediately, keep loop open for further codes/drops
                serverRedeemCode(code, cfg).then(outcome => {
                    if (!outcome || !outcome.success) {
                        sniperLog(`🔄 Key "${code}" invalid or claimed. Standing by on ${channelName} (10m) scanning for next code...`, 'warn');
                        pushEvent('key_failed_standby', {
                            code,
                            status: outcome ? outcome.status : 'failed',
                            channel_id: msg.channel_id,
                            channel_name: channelName
                        });
                    }
                }).catch(e => {
                    sniperLog(`❌ Redeem error for "${code}": ${e.message}. Standing by on ${channelName}...`, 'error');
                });
            } else {
                sniperLog(`Auto-redeem OFF. Code captured: ${code}`);
                sniperState.recentCodes.push({
                    code, status: 'captured', time: new Date().toISOString(), ms: 0
                });
            }
        }
    }

    // Buffer messages for anti-trap context
    recentMessagesBuffer.push({ author, content, time: Date.now() });
    if (recentMessagesBuffer.length > 10) recentMessagesBuffer.shift();

    // Push message to SSE for dashboard live view
    pushEvent('message', {
        author,
        content: content.substring(0, 500),
        channel_id: msg.channel_id,
        channel_name: channelName,
        timestamp: msg.timestamp
    });
}

function stopServerSniper() {
    sniperState.running = false;
    sniperState.status = 'STOPPED';
    if (sniperHeartbeat) clearInterval(sniperHeartbeat);
    sniperHeartbeat = null;
    if (sniperWs) {
        try { sniperWs.close(1000); } catch (e) {}
        sniperWs = null;
    }
    sniperLog('Server-side sniper stopped.', 'warn');
    pushEvent('status', { status: 'STOPPED' });
}

// ============================================
// Speed Benchmark
// ============================================

async function runSpeedBenchmark() {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
    const fakeCode = `SPY-TEST-${Date.now().toString(36).toUpperCase().substring(0, 4)}-BNCH`;
    const start = Date.now();

    sniperLog(`🏎️ Speed benchmark starting with fake code: ${fakeCode}`);

    // Measure: regex match time
    const regexStart = Date.now();
    const regex = new RegExp(cfg.codeRegex || 'SPY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}', 'gi');
    const matched = fakeCode.match(regex);
    const regexMs = Date.now() - regexStart;

    // Measure: anti-trap check time
    const trapStart = Date.now();
    const trapResult = isTrapContext('test message ' + fakeCode);
    const trapMs = Date.now() - trapStart;

    // Measure: HTTP request to SpyHub (cold)
    const httpStart = Date.now();
    try {
        await httpsFetch('https://spyhub-web.spyuhq.workers.dev/api/site/giftcard', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://spyhub.kdns.fr',
                'User-Agent': 'Mozilla/5.0 Chrome/120.0.0.0'
            },
            body: JSON.stringify({ code: fakeCode })
        });
    } catch (e) {}
    const httpMs = Date.now() - httpStart;

    const totalMs = Date.now() - start;

    const results = {
        total_ms: totalMs,
        regex_ms: regexMs,
        trap_check_ms: trapMs,
        http_redeem_ms: httpMs,
        code: fakeCode,
        regex_matched: !!matched
    };

    sniperLog(`🏎️ Benchmark done! Total: ${totalMs}ms (Regex: ${regexMs}ms, Trap: ${trapMs}ms, HTTP: ${httpMs}ms)`, 'success');
    return results;
}

// ============================================
// API Routes
// ============================================

// Health check
app.get('/healthz', (req, res) => {
    res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        sniper: sniperState.status,
        stats: sniperState.stats
    });
});

// Config GET/POST
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

app.post('/api/config', (req, res) => {
    try {
        const newConfig = req.body || {};
        persistServerConfig(newConfig);
        // Auto-run headless sniper on server if token and channel are present
        if (newConfig.token && newConfig.channelId && !sniperState.running) {
            console.log('[Auto-Run] Config updated with token & channels. Auto-starting server sniper...');
            setTimeout(() => startServerSniper(), 500);
        }
        res.json({ success: true, message: 'Settings and state permanently saved' });
    } catch (err) {
        console.error('Error writing config:', err);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Server-side sniper control
app.post('/api/sniper/redeem', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
        const outcome = await serverRedeemCode(code, cfg);
        res.json(outcome);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sniper/start', (req, res) => {
    if (sniperState.running) {
        return res.json({ success: false, message: 'Sniper already running', state: sniperState });
    }
    const ok = startServerSniper();
    res.json({ success: ok, state: sniperState });
});

app.post('/api/sniper/stop', (req, res) => {
    stopServerSniper();
    res.json({ success: true, state: sniperState });
});

app.get('/api/sniper/status', (req, res) => {
    if (sniperState.hotChannel && sniperState.hotChannel.until && Date.now() > sniperState.hotChannel.until) {
        sniperState.hotChannel = { id: null, name: null, until: 0, reason: null };
    }
    res.json({
        ...sniperState,
        uptime: sniperState.startTime ? Math.floor((Date.now() - sniperState.startTime) / 1000) : 0
    });
});

// Speed benchmark
app.get('/api/sniper/benchmark', async (req, res) => {
    try {
        const results = await runSpeedBenchmark();
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SSE endpoint for live dashboard updates
app.get('/api/sniper/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    // Send current state immediately
    res.write(`data: ${JSON.stringify({ type: 'init', state: sniperState })}\n\n`);

    sseClients.push(res);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
    });
});

// Default route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// Keep-Alive Worker for Render 24/7
function startKeepAliveWorker() {
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    if (renderUrl) {
        console.log(`[Keep-Alive] Active for URL: ${renderUrl}`);
        setInterval(() => {
            httpsFetch(`${renderUrl}/healthz`).catch(() => {});
        }, 10 * 60 * 1000); // ping every 10 mins
    }
}

// ============================================
// Auto-Start Sniper on Boot (if config exists)
// ============================================

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Render] SpyHub Sniper listening on port ${PORT}`);
    startKeepAliveWorker();

    // Auto-start sniper if config exists
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
            if (cfg.token && cfg.channelId) {
                console.log('[Auto-Start] Config found with token + channels. Starting headless sniper...');
                setTimeout(() => startServerSniper(), 1500);
            }
        }
    } catch (e) {
        console.error('[Auto-Start] Error:', e.message);
    }
});
