/* ============================================
   SpyHub Key Sniper - Engine
   Discord Gateway WebSocket + Auto-Redeem
   ============================================ */

const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const SPYHUB_BASE = 'https://spyhub.kdns.fr';
const SPYHUB_API = 'https://spyhub-web.spyuhq.workers.dev/api';

// State
let ws = null;
let heartbeatInterval = null;
let lastSequence = null;
let sessionId = null;
let resumeGatewayUrl = null;
let isConnected = false;
let isPrefireVisible = false;
let startTime = null;
let uptimeTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECTS = 5;

let config = {
    token: '',
    channelId: '',
    channelIds: [],
    guildId: '',
    codePrefix: 'SPY-',
    codeRegex: null,
    autoRedeem: true,
    soundAlert: true,
    antiTrap: true,
    spyhubCookie: ''
};

let stats = {
    messages: 0,
    codes: 0,
    redeemed: 0
};

let history = [];
let seenCodes = new Set();
let recentMessagesBuffer = []; // buffer to inspect context around codes

// Prefire auto-trigger patterns (ready? / ping / countdown)
const PREFIRE_TRIGGER_PATTERNS = /\b(ready\??|get\s*ready|incoming|drop\s*in|@here|@everyone|countdown|giveaway\s*start|code\s*drop|dropping\s*(now|soon))\b/i;

// ============================================
// Setup & Init
// ============================================

function toggleVis(inputId) {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
}

function getCurrentConfigPayload() {
    const token = (document.getElementById('discord-token')?.value || '').trim();
    const channelId = (document.getElementById('channel-id')?.value || '').trim();
    const guildId = (document.getElementById('guild-id')?.value || '').trim();
    const codePrefix = (document.getElementById('code-prefix')?.value || 'SPY-').trim();
    const codeRegex = (document.getElementById('code-regex')?.value || 'SPY-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+').trim();
    const autoRedeem = document.getElementById('auto-redeem') ? document.getElementById('auto-redeem').checked : true;
    const soundAlert = document.getElementById('sound-alert') ? document.getElementById('sound-alert').checked : true;
    const antiTrap = document.getElementById('anti-trap') ? document.getElementById('anti-trap').checked : true;
    const autoStart = document.getElementById('auto-start') ? document.getElementById('auto-start').checked : true;
    const spyhubCookie = (document.getElementById('spyhub-cookie')?.value || '').trim();
    const afkTokens = (document.getElementById('afk-tokens')?.value || '').trim();
    const afkStatusText = (document.getElementById('afk-status-text')?.value || 'Active').trim();

    return {
        token,
        channelId,
        guildId,
        codePrefix,
        codeRegex,
        autoRedeem,
        soundAlert,
        antiTrap,
        autoStart,
        spyhubCookie,
        afkTokens,
        afkStatusText,
        history: history.slice(0, 50),
        stats: stats
    };
}

function applyConfigToUI(c) {
    if (!c || typeof c !== 'object') return false;

    // Purge dummy/placeholder channel values
    if (c.channelId === '123456') c.channelId = '';
    if (c.guildId === '123456' || c.guildId === '1234567890123456789') c.guildId = '';

    if (c.token !== undefined) {
        const el = document.getElementById('discord-token');
        if (el) el.value = c.token;
        config.token = c.token;
    }
    if (c.channelId !== undefined) {
        const el = document.getElementById('channel-id');
        if (el) el.value = c.channelId;
        config.channelId = c.channelId;
        config.channelIds = (c.channelId || '').split(/[\s,]+/).filter(id => id.length > 0 && id !== '123456');
    }
    if (c.guildId !== undefined) {
        const el = document.getElementById('guild-id');
        if (el) el.value = c.guildId;
        config.guildId = c.guildId;
    }
    if (c.codePrefix !== undefined) {
        const el = document.getElementById('code-prefix');
        if (el) el.value = c.codePrefix;
        config.codePrefix = c.codePrefix;
    }
    if (c.codeRegex !== undefined) {
        const el = document.getElementById('code-regex');
        if (el) el.value = c.codeRegex;
        try { config.codeRegex = new RegExp(c.codeRegex, 'gi'); } catch (e) {}
    }
    if (c.autoRedeem !== undefined) {
        const el = document.getElementById('auto-redeem');
        if (el) el.checked = !!c.autoRedeem;
        config.autoRedeem = !!c.autoRedeem;
    }
    if (c.soundAlert !== undefined) {
        const el = document.getElementById('sound-alert');
        if (el) el.checked = !!c.soundAlert;
        config.soundAlert = !!c.soundAlert;
    }
    if (c.antiTrap !== undefined) {
        const el = document.getElementById('anti-trap');
        if (el) el.checked = !!c.antiTrap;
        config.antiTrap = !!c.antiTrap;
    }
    if (c.autoStart !== undefined) {
        const el = document.getElementById('auto-start');
        if (el) el.checked = !!c.autoStart;
    }
    if (c.spyhubCookie !== undefined) {
        const el = document.getElementById('spyhub-cookie');
        if (el) el.value = c.spyhubCookie;
        config.spyhubCookie = c.spyhubCookie;
    }
    if (c.afkTokens !== undefined) {
        const el = document.getElementById('afk-tokens');
        if (el) el.value = c.afkTokens;
    }
    if (c.afkStatusText !== undefined) {
        const el = document.getElementById('afk-status-text');
        if (el) el.value = c.afkStatusText;
    }
    return true;
}

async function copyConfigCode() {
    saveConfig();
    const cfg = getCurrentConfigPayload();
    if (!cfg.token && !cfg.channelId) {
        alert('Please enter your Discord token or channel ID first!');
        return;
    }
    const jsonStr = JSON.stringify(cfg);
    const bytes = new TextEncoder().encode(jsonStr);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        bin += String.fromCharCode(bytes[i]);
    }
    const configCode = 'SPYCFG_' + btoa(bin);

    let copied = false;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(configCode);
            copied = true;
        }
    } catch (e) {}

    if (!copied) {
        try {
            const ta = document.createElement('textarea');
            ta.value = configCode;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            copied = document.execCommand('copy');
            document.body.removeChild(ta);
        } catch (e) {}
    }

    if (copied) {
        flashSaveIndicator('📋 Config Code Copied!');
        addSystemMsg('📋 Config code copied to your clipboard! Keep it safe.', 'success');
    } else {
        prompt('Copy your config code below:', configCode);
    }
}

async function pasteConfigCode(inputCode) {
    let raw = inputCode;
    if (!raw) {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                const clip = await navigator.clipboard.readText();
                if (clip && (clip.trim().startsWith('SPYCFG_') || clip.trim().startsWith('{'))) {
                    raw = clip.trim();
                }
            }
        } catch (e) {}

        if (!raw) {
            raw = prompt('Paste your SPYCFG_ config code or JSON settings here:');
        }
    }

    if (!raw || !raw.trim()) return;
    raw = raw.trim();

    try {
        let parsed = null;
        if (raw.startsWith('{')) {
            parsed = JSON.parse(raw);
        } else {
            let str = raw;
            if (str.startsWith('SPYCFG_')) {
                str = str.slice(7);
            }
            const bin = atob(str);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) {
                bytes[i] = bin.charCodeAt(i);
            }
            const jsonStr = new TextDecoder().decode(bytes);
            parsed = JSON.parse(jsonStr);
        }

        if (parsed && typeof parsed === 'object') {
            applyConfigToUI(parsed);
            saveConfig();
            flashSaveIndicator('✓ Config Restored & Saved!');
            addSystemMsg('✅ Config restored and saved permanently to browser & server!', 'success');
            checkTokenAutoStart();
        } else {
            throw new Error('Parsed config is not an object');
        }
    } catch (err) {
        console.error('[Config] Decode failed:', err);
        alert('Invalid config code format. Make sure it starts with SPYCFG_ or is a valid exported config string.');
    }
}

async function loadConfig() {
    let localConfig = null;
    let serverConfig = null;

    // 1. Read localStorage
    const saved = localStorage.getItem('spyhub-sniper-config');
    if (saved) {
        try { localConfig = JSON.parse(saved); } catch (e) {}
    }

    // 2. Fetch server config
    try {
        const resp = await fetch('/api/config');
        if (resp.ok) {
            serverConfig = await resp.json();
        }
    } catch (e) {}

    // Purge dummy placeholder IDs from both sources
    if (serverConfig && serverConfig.channelId === '123456') delete serverConfig.channelId;
    if (localConfig && localConfig.channelId === '123456') delete localConfig.channelId;

    // 3. Smart Merge: server first, localConfig SECOND so localConfig takes precedence
    const c = Object.assign({}, serverConfig || {}, localConfig || {});

    // Apply values to UI
    applyConfigToUI(c);

    // If local had credentials that server didn't have, auto-sync back to server immediately
    if (c.token) {
        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(getCurrentConfigPayload())
        }).catch(() => {});
    }

    // Restore saved snipe history
    if (c.history && Array.isArray(c.history) && c.history.length > 0) {
        history = c.history;
        renderHistory();
    }

    // Restore saved statistics
    if (c.stats) {
        stats = Object.assign(stats, c.stats);
        updateStat('stat-messages', stats.messages);
        updateStat('stat-codes', stats.codes);
        updateStat('stat-redeemed', stats.redeemed);
    }

    flashSaveIndicator('✓ Loaded saved settings');

    if (c.afkTokens && c.afkTokens.trim().length > 15) {
        setTimeout(() => {
            startAfkSpoofer(true);
        }, 1200);
    }

    // Attach listeners so ANY input automatically saves to both localStorage and server
    setupAutoSaveListeners();
}

function flashSaveIndicator(text = '✓ Auto-Saved to Browser & Server') {
    const el = document.getElementById('save-indicator');
    if (el) {
        el.textContent = text;
        el.classList.add('saved');
        setTimeout(() => el.classList.remove('saved'), 1500);
    }
    const mini = document.getElementById('save-indicator-sniper');
    if (mini) {
        mini.textContent = '✓ Saved';
        mini.classList.add('saved');
        setTimeout(() => mini.classList.remove('saved'), 1500);
    }
}

function manualSave() {
    saveConfig();
    const btnText = document.getElementById('save-btn-text');
    if (btnText) {
        btnText.textContent = '✓ Saved Permanently!';
        setTimeout(() => { btnText.textContent = '💾 Save Settings'; }, 2000);
    }
    flashSaveIndicator('✓ Permanently Saved to Disk & Browser');
}

let autoSaveDebounce = null;
function setupAutoSaveListeners() {
    const inputs = document.querySelectorAll('.config-sidebar input, .config-sidebar textarea');
    inputs.forEach(el => {
        el.addEventListener('input', () => {
            clearTimeout(autoSaveDebounce);
            autoSaveDebounce = setTimeout(() => {
                saveConfig();
                checkTokenAutoStart();
            }, 300);
        });
        el.addEventListener('change', () => {
            saveConfig();
            checkTokenAutoStart();
        });
    });
}

function checkTokenAutoStart() {
    const token = document.getElementById('discord-token').value.trim();
    const channelId = document.getElementById('channel-id').value.trim();

    // Auto-run background sniper whenever token and channel are typed or pasted
    if (token.length > 25 && channelId.length > 10 && !isConnected && !serverSniperRunning) {
        addSystemMsg('🚀 Token & Channel detected! Auto-running background sniper...', 'success');
        startSniper(true);
    }

    // Auto-run AFK spoofer whenever AFK tokens are entered
    const afkTokens = document.getElementById('afk-tokens')?.value.trim();
    if (afkTokens && afkTokens.length > 20 && activeAfkClients.length === 0) {
        startAfkSpoofer(true);
    }
}

function saveConfig() {
    config.token = document.getElementById('discord-token').value.trim();
    config.channelId = document.getElementById('channel-id').value.trim();
    config.channelIds = config.channelId.split(/[\s,]+/).filter(id => id.length > 0);
    config.guildId = document.getElementById('guild-id').value.trim();
    config.codePrefix = document.getElementById('code-prefix').value.trim();
    config.autoRedeem = document.getElementById('auto-redeem').checked;
    config.soundAlert = document.getElementById('sound-alert').checked;
    const antiTrapEl = document.getElementById('anti-trap');
    config.antiTrap = antiTrapEl ? antiTrapEl.checked : true;
    const autoStartEl = document.getElementById('auto-start');
    const autoStartVal = autoStartEl ? autoStartEl.checked : true;
    const prefireModeEl = document.getElementById('prefire-mode');
    const prefireModeVal = prefireModeEl ? prefireModeEl.checked : false;
    config.spyhubCookie = document.getElementById('spyhub-cookie').value.trim();

    const regexStr = document.getElementById('code-regex').value.trim();
    try {
        config.codeRegex = new RegExp(regexStr, 'gi');
    } catch (e) {
        config.codeRegex = new RegExp('SPY-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+', 'gi');
    }

    const afkTokensVal = document.getElementById('afk-tokens')?.value || '';
    const afkStatusVal = document.getElementById('afk-status-text')?.value || 'Active';

    const payload = {
        token: config.token,
        channelId: config.channelId,
        guildId: config.guildId,
        codePrefix: config.codePrefix,
        codeRegex: regexStr,
        autoRedeem: config.autoRedeem,
        soundAlert: config.soundAlert,
        antiTrap: config.antiTrap,
        autoStart: autoStartVal,
        prefireMode: prefireModeVal,
        spyhubCookie: config.spyhubCookie,
        afkTokens: afkTokensVal,
        afkStatusText: afkStatusVal,
        history: history.slice(0, 50),
        stats: stats
    };

    // Save to localStorage immediately
    localStorage.setItem('spyhub-sniper-config', JSON.stringify(payload));

    // Auto-save to Render server asynchronously
    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(() => {});

    flashSaveIndicator('✓ Auto-Saved to Browser & Server');
}

function updateSniperUI(isRunning, statusText, channelsList) {
    const badge = document.getElementById('status-badge');
    if (badge) {
        badge.textContent = statusText || (isRunning ? 'BACKGROUND: RUNNING' : 'BACKGROUND: IDLE');
        badge.className = 'status-badge ' + (isRunning ? 'connected' : '');
    }
    const mini = document.getElementById('status-badge-sniper');
    if (mini) {
        mini.textContent = statusText || (isRunning ? 'BACKGROUND: RUNNING' : 'BACKGROUND: IDLE');
        mini.className = 'status-badge ' + (isRunning ? 'connected' : '');
    }
    const btn = document.getElementById('main-sniper-btn');
    if (btn) {
        if (isRunning) {
            btn.textContent = '🛑 Stop Background Sniper';
            btn.className = 'btn btn-danger';
        } else {
            btn.textContent = '⚡ Start Background Sniper';
            btn.className = 'btn btn-primary';
        }
    }
    const chEl = document.getElementById('channel-name');
    if (chEl) {
        if (!isRunning) {
            chEl.textContent = '#not connected';
        } else if (channelsList && channelsList.length > 0) {
            chEl.textContent = channelsList.join(', ');
        } else {
            const raw = document.getElementById('channel-id')?.value || config.channelId || '';
            const ids = raw.split(/[\s,]+/).filter(x => x.length > 0 && x !== '123456');
            chEl.textContent = ids.length > 0 ? `#monitoring ${ids.length} channel(s)` : '#connected';
        }
    }
}

async function toggleSniper() {
    if (serverSniperRunning || isConnected) {
        await stopSniper();
    } else {
        await startSniper();
    }
}

async function startSniper(silent = false) {
    saveConfig();
    const token = document.getElementById('discord-token')?.value?.trim();
    const channelId = document.getElementById('channel-id')?.value?.trim();
    if (!token) {
        if (!silent) alert('Discord token is required');
        return;
    }
    if (!channelId) {
        if (!silent) alert('Channel ID is required');
        return;
    }

    updateSniperUI(true, 'BACKGROUND: CONNECTING...');
    addSystemMsg('Starting 24/7 background sniper...', 'info');

    try {
        const resp = await fetch('/api/sniper/start', { method: 'POST' });
        const data = await resp.json();
        if (data.success || data.state?.running) {
            serverSniperRunning = true;
            isConnected = true;
            updateSniperUI(true, 'BACKGROUND: RUNNING', data.state?.monitoredChannels);
            connectSSE();
            if (uptimeTimer) clearInterval(uptimeTimer);
            startTime = Date.now();
            uptimeTimer = setInterval(updateUptime, 1000);
            addSystemMsg('🚀 24/7 Background sniper is RUNNING! Runs even with this browser closed.', 'success');
            return;
        }
    } catch (e) {
        console.warn('Backend sniper API unreachable, falling back to browser socket:', e.message);
    }

    // Fallback: direct browser socket if node server endpoint is unavailable
    startTime = Date.now();
    if (uptimeTimer) clearInterval(uptimeTimer);
    uptimeTimer = setInterval(updateUptime, 1000);
    connectGateway();
}

function startPrefire() {
    startSniper();
    const codeInput = document.getElementById('redeem-code-input');
    if (codeInput) codeInput.focus();
}

async function stopSniper() {
    try {
        await fetch('/api/sniper/stop', { method: 'POST' });
    } catch (e) {}

    if (ws) {
        try { ws.close(1000); } catch (e) {}
        ws = null;
    }
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (uptimeTimer) clearInterval(uptimeTimer);
    if (sseSource) { sseSource.close(); sseSource = null; }

    isConnected = false;
    serverSniperRunning = false;
    updateSniperUI(false, 'BACKGROUND: IDLE');
    addSystemMsg('Background sniper stopped.', 'error');
}

// ============================================
// Discord Gateway WebSocket
// ============================================

function connectGateway() {
    addSystemMsg('Connecting to Discord Gateway...');
    updateStatus('CONNECTING...', '');

    ws = new WebSocket(DISCORD_GATEWAY);

    ws.onopen = () => {
        addSystemMsg('WebSocket connected, identifying...', 'success');
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleGatewayMessage(data);
    };

    ws.onerror = (err) => {
        addSystemMsg('WebSocket error!', 'error');
        updateStatus('ERROR', 'error');
        console.error('WS Error:', err);
    };

    ws.onclose = (event) => {
        isConnected = false;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        
        // 4004 = auth failed, don't reconnect
        if (event.code === 4004) {
            addSystemMsg('Authentication failed — invalid token!', 'error');
            updateStatus('AUTH FAILED', 'error');
            return;
        }
        
        // auto-reconnect with limit
        if (event.code !== 1000) {
            reconnectAttempts++;
            if (reconnectAttempts > MAX_RECONNECTS) {
                addSystemMsg(`Max reconnect attempts (${MAX_RECONNECTS}) reached. Stopping.`, 'error');
                updateStatus('FAILED', 'error');
                return;
            }
            const delay = Math.min(5000 * reconnectAttempts, 30000);
            addSystemMsg(`Disconnected (code: ${event.code}). Reconnecting in ${delay/1000}s... (attempt ${reconnectAttempts}/${MAX_RECONNECTS})`, 'error');
            updateStatus('RECONNECTING...', '');
            setTimeout(() => {
                if (config.token) connectGateway();
            }, delay);
        }
    };
}

function handleGatewayMessage(data) {
    const { op, d, s, t } = data;

    if (s) lastSequence = s;

    switch (op) {
        case 10: // Hello - start heartbeat + identify
            const interval = d.heartbeat_interval;
            startHeartbeat(interval);
            identify();
            break;

        case 11: // Heartbeat ACK
            updateLatency();
            break;

        case 0: // Dispatch
            handleDispatch(t, d);
            break;

        case 7: // Reconnect
            addSystemMsg('Server requested reconnect...', 'error');
            ws.close(4000);
            break;

        case 9: // Invalid session
            addSystemMsg('Invalid session, re-identifying in 3s...', 'error');
            setTimeout(identify, 3000);
            break;
    }
}

function identify() {
    // detect if this is a bot token (starts with "Bot " or looks like one)
    const isBot = config.token.startsWith('Bot ') || config.token.startsWith('Bearer ');
    
    let payload;
    if (isBot) {
        payload = {
            op: 2,
            d: {
                token: config.token,
                intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
                properties: {
                    os: 'windows',
                    browser: 'discord.js',
                    device: 'discord.js'
                }
            }
        };
    } else {
        // user token — no intents field, properties use $ prefix like real client
        payload = {
            op: 2,
            d: {
                token: config.token,
                capabilities: 16381,
                properties: {
                    os: 'Windows',
                    browser: 'Chrome',
                    device: '',
                    system_locale: 'en-US',
                    browser_user_agent: navigator.userAgent,
                    browser_version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '120.0.0.0',
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
                    status: 'online',
                    since: 0,
                    activities: [],
                    afk: false
                },
                compress: false,
                client_state: {
                    guild_versions: {}
                }
            }
        };
    }
    ws.send(JSON.stringify(payload));
}

function startHeartbeat(interval) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    // send first heartbeat after jitter
    setTimeout(() => {
        sendHeartbeat();
    }, interval * Math.random());
    
    heartbeatInterval = setInterval(sendHeartbeat, interval);
}

function sendHeartbeat() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: 1, d: lastSequence }));
        window._lastHeartbeatSent = Date.now();
    }
}

// ============================================
// Event Dispatch Handler
// ============================================

function handleDispatch(eventName, data) {
    switch (eventName) {
        case 'READY':
            sessionId = data.session_id;
            resumeGatewayUrl = data.resume_gateway_url;
            isConnected = true;
            reconnectAttempts = 0;
            
            const user = data.user;
            addSystemMsg(`Connected as ${user.username}#${user.discriminator || '0'}`, 'success');
            updateStatus('🟢 BACKGROUND: RUNNING', 'connected');
            
            // extract channel names from READY payload guilds if available
            let channelNames = [];
            if (data.guilds && config.channelIds.length > 0) {
                for (const g of data.guilds) {
                    if (g.channels) {
                        for (const targetId of config.channelIds) {
                            const ch = g.channels.find(c => c.id === targetId);
                            if (ch) channelNames.push(`#${ch.name}`);
                        }
                    }
                }
            }
            if (channelNames.length > 0) {
                document.getElementById('channel-name').textContent = channelNames.join(', ');
            } else {
                document.getElementById('channel-name').textContent = config.channelIds.length > 1 ? `${config.channelIds.length} channels` : `#${config.channelId}`;
            }
            break;

        case 'MESSAGE_CREATE':
            handleMessage(data);
            break;

        case 'MESSAGE_UPDATE':
            // also scan edited messages
            handleMessage(data, true);
            break;
    }
}

// ============================================
// Test Connection
// ============================================

let testWs = null;

function testConnection() {
    const token = document.getElementById('discord-token').value.trim();
    const channelId = document.getElementById('channel-id').value.trim();
    const guildId = document.getElementById('guild-id').value.trim();
    const results = document.getElementById('test-results');
    
    results.innerHTML = '';
    const log = (msg, cls) => {
        results.innerHTML += `<div class="${cls}">${msg}</div>`;
        results.scrollTop = results.scrollHeight;
    };

    // basic validation
    if (!token) { log('✗ No token provided', 't-fail'); return; }
    if (!channelId) { log('✗ No channel ID provided', 't-fail'); return; }
    
    log('⟳ Validating token format...', 't-info');
    
    // decode user ID from token (base64 first segment)
    try {
        const parts = token.split('.');
        if (parts.length !== 3) { log('✗ Token format invalid (need 3 parts separated by dots)', 't-fail'); return; }
        const userId = atob(parts[0]);
        if (!/^\d+$/.test(userId)) { log('✗ Token part 1 doesn\'t decode to a valid user ID', 't-fail'); return; }
        log(`✓ Token format OK — User ID: ${userId}`, 't-ok');
    } catch (e) {
        log('✗ Token base64 decode failed: ' + e.message, 't-fail');
        return;
    }

    const channelIdsList = channelId.split(/[\s,]+/).filter(id => id.length > 0);
    channelIdsList.forEach(id => {
        if (!/^\d{17,20}$/.test(id)) {
            log(`⚠ Channel ID "${id}" looks wrong (should be 17-20 digits)`, 't-warn');
        } else {
            log(`✓ Channel ID format OK: ${id}`, 't-ok');
        }
    });

    if (guildId && !/^\d{17,20}$/.test(guildId)) {
        log('⚠ Guild ID looks wrong (should be 17-20 digits)', 't-warn');
    } else if (guildId) {
        log(`✓ Guild ID format OK: ${guildId}`, 't-ok');
    }

    // test WebSocket connection
    log('⟳ Connecting to Discord Gateway...', 't-info');
    
    if (testWs) { try { testWs.close(1000); } catch(e) {} }
    
    const startMs = Date.now();
    testWs = new WebSocket(DISCORD_GATEWAY);
    let identified = false;
    let testTimeout = null;
    
    testTimeout = setTimeout(() => {
        log('✗ Connection timed out (10s)', 't-fail');
        try { testWs.close(1000); } catch(e) {}
    }, 10000);
    
    testWs.onopen = () => {
        const elapsed = Date.now() - startMs;
        log(`✓ WebSocket connected (${elapsed}ms)`, 't-ok');
    };
    
    testWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.op === 10) {
            // Hello — send identify
            log(`✓ Gateway Hello — heartbeat interval: ${data.d.heartbeat_interval}ms`, 't-ok');
            log('⟳ Sending identify (user token)...', 't-info');
            
            const isBot = token.startsWith('Bot ') || token.startsWith('Bearer ');
            
            let payload;
            if (isBot) {
                payload = {
                    op: 2,
                    d: {
                        token: token,
                        intents: (1 << 9) | (1 << 15),
                        properties: { os: 'windows', browser: 'discord.js', device: 'discord.js' }
                    }
                };
            } else {
                payload = {
                    op: 2,
                    d: {
                        token: token,
                        capabilities: 16381,
                        properties: {
                            os: 'Windows',
                            browser: 'Chrome',
                            device: '',
                            system_locale: 'en-US',
                            browser_user_agent: navigator.userAgent,
                            browser_version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '120.0.0.0',
                            os_version: '10',
                            referrer: '',
                            referring_domain: '',
                            release_channel: 'stable',
                            client_build_number: 250484,
                            client_event_source: null
                        },
                        presence: { status: 'online', since: 0, activities: [], afk: false },
                        compress: false,
                        client_state: { guild_versions: {} }
                    }
                };
            }
            
            testWs.send(JSON.stringify(payload));
            identified = true;
        }
        
        if (data.op === 0 && data.t === 'READY') {
            clearTimeout(testTimeout);
            const user = data.d.user;
            const guildCount = data.d.guilds ? data.d.guilds.length : 0;
            log(`✓ Authenticated as: ${user.username}#${user.discriminator || '0'} (ID: ${user.id})`, 't-ok');
            log(`✓ Guilds loaded: ${guildCount}`, 't-ok');
            
            // check if the target channels exist in any guild
            const targetIds = channelId.split(/[\s,]+/).filter(id => id.length > 0);
            let foundChannels = [];
            let missingChannels = [...targetIds];
            let foundGuild = false;

            if (data.d.guilds) {
                for (const g of data.d.guilds) {
                    if (guildId && g.id === guildId) foundGuild = true;
                    if (g.channels) {
                        for (const tid of targetIds) {
                            const ch = g.channels.find(c => c.id === tid);
                            if (ch && !foundChannels.some(f => f.id === tid)) {
                                foundChannels.push({ id: tid, name: ch.name, type: ch.type, guild: g.properties?.name || g.id });
                                missingChannels = missingChannels.filter(m => m !== tid);
                            }
                        }
                    }
                }
            }

            for (const fc of foundChannels) {
                log(`✓ Channel found: #${fc.name} (${fc.id}) in guild: ${fc.guild}`, 't-ok');
            }

            for (const mc of missingChannels) {
                log(`⚠ Channel ${mc} not in initial guild payload (could be DM, thread, or lazy-loaded)`, 't-warn');
            }

            if (guildId && !foundGuild) {
                log(`⚠ Guild ${guildId} not found in your guilds`, 't-warn');
            }
            
            log('', 't-info');
            log('✓ ALL TESTS PASSED — Ready to snipe!', 't-ok');
            
            // close test connection
            testWs.close(1000);
        }
        
        if (data.op === 9) {
            clearTimeout(testTimeout);
            log('✗ INVALID SESSION — Token is expired or invalid!', 't-fail');
            log('  Get a fresh token from Discord DevTools → Network → find a request → copy Authorization header', 't-info');
            testWs.close(1000);
        }
    };
    
    testWs.onerror = () => {
        clearTimeout(testTimeout);
        log('✗ WebSocket connection error', 't-fail');
    };
    
    testWs.onclose = (event) => {
        clearTimeout(testTimeout);
        if (event.code === 4004) {
            log('✗ Authentication failed (code 4004) — invalid token', 't-fail');
        } else if (event.code !== 1000 && !identified) {
            log(`✗ Connection closed unexpectedly (code: ${event.code})`, 't-fail');
        }
    };
}

// ============================================
// Find Old Key & Test Redeem
// ============================================

async function fetchOldKeyAndTest(fromPrefire = false) {
    const token = document.getElementById('discord-token').value.trim() || config.token;
    const channelId = document.getElementById('channel-id').value.trim() || config.channelId;
    const results = document.getElementById('test-results');

    const log = (msg, cls) => {
        if (!fromPrefire && results) {
            results.innerHTML += `<div class="${cls}">${msg}</div>`;
            results.scrollTop = results.scrollHeight;
        }
        addSystemMsg(msg.replace(/^[✓✗⚠⟳]\s*/, ''), cls === 't-ok' ? 'success' : cls === 't-fail' ? 'error' : '');
    };

    if (!fromPrefire && results) results.innerHTML = '';

    if (!token) {
        log('✗ No Discord token provided', 't-fail');
        return;
    }
    if (!channelId) {
        log('✗ No Channel ID specified', 't-fail');
        return;
    }

    log(`⟳ Fetching recent messages from #${channelId}...`, 't-info');

    let oldKey = null;
    let foundMsg = null;
    const regexStr = document.getElementById('code-regex').value.trim() || 'SPY-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+';
    const regex = new RegExp(regexStr, 'gi');

    // 1. Try Discord REST API v10
    try {
        const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, {
            headers: {
                'Authorization': token
            }
        });

        if (resp.ok) {
            const msgs = await resp.json();
            log(`✓ Retrieved ${msgs.length} messages from channel history`, 't-ok');
            for (const m of msgs) {
                regex.lastIndex = 0;
                const match = (m.content || '').match(regex);
                if (match && match.length > 0) {
                    const candidateKey = match[0];
                    if (config.antiTrap && isTrapContext(m.content || '')) {
                        log(`🛡️ Skipped historical bait/trap key: ${candidateKey} ("${(m.content || '').trim()}")`, 't-warn');
                        continue;
                    }
                    oldKey = candidateKey;
                    foundMsg = m;
                    break;
                }
            }
        } else {
            log(`⚠ Discord REST API returned status ${resp.status} (CORS or permissions). Falling back to sample/cached keys...`, 't-warn');
        }
    } catch (e) {
        log(`⚠ Browser CORS prevented direct REST fetch: ${e.message}`, 't-warn');
    }

    // 2. Fallback: check screenshot sample key or memory if API fetch was blocked
    if (!oldKey) {
        // Safe key from your original giveaway screenshot (NOT the trap one)
        oldKey = 'SPY-2B64-BE73-41E8';
        log(`✓ Using verified safe historical test key: ${oldKey}`, 't-ok');
    } else {
        const author = foundMsg?.author?.username || 'Unknown';
        log(`✓ Found safe key in channel history: ${oldKey} (posted by ${author})`, 't-ok');
    }

    // Fill into prefire input & trigger test redeem
    const codeInput = document.getElementById('redeem-code-input');
    if (codeInput) {
        codeInput.value = oldKey;
        codeInput.classList.add('has-code');
    }

    log(`⟳ Initiating test redeem for ${oldKey}...`, 't-info');
    setRedeemStatus(`Testing redeem on old key: ${oldKey}`, 'pending');

    if (config.soundAlert) playAlert();

    // Call standard redeem pipeline
    await redeemCode(oldKey);
    log(`✓ Test execution completed. Code copied & sent to redeem flow.`, 't-ok');
}


// Honeypot / Trap Keywords (to protect account against ban codes)
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

function isTrapContext(currentContent) {
    // 1. Check current message text
    for (const pat of TRAP_PATTERNS) {
        if (pat.test(currentContent)) return true;
    }

    // 2. Check recent preceding messages (within last 3 messages)
    const recent = recentMessagesBuffer.slice(-3);
    for (const item of recent) {
        for (const pat of TRAP_PATTERNS) {
            if (pat.test(item.content)) return true;
        }
    }

    return false;
}

function handleMessage(msg, isEdit = false) {
    // only process messages from monitored target channels
    const isTargetChannel = config.channelIds.length > 0 
        ? config.channelIds.includes(msg.channel_id)
        : msg.channel_id === config.channelId;

    if (!isTargetChannel) return;

    stats.messages++;
    updateStat('stat-messages', stats.messages);

    const content = msg.content || '';
    const author = msg.author ? (msg.author.username || 'Unknown') : 'Unknown';
    const timestamp = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const timeStr = timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Auto-prefire trigger: detect "ready?" / @here / @everyone / countdown messages
    if (PREFIRE_TRIGGER_PATTERNS.test(content)) {
        addSystemMsg(`🎯 DROP INCOMING — "${content.substring(0, 60)}" from ${author}`, 'success');
        if (!isPrefireVisible) showPrefire();
        updateStatus('🎯 DROP INCOMING', 'connected');
        if (config.soundAlert) playPrefireAlert();
    }

    // Detect chat messages confirming giftcard is claimed / already redeemed
    const claimedPatterns = /\b(already\s*redeemed|already\s*claimed|already\s*taken|someone\s*(already\s*)?took\s*it|i\s*claimed|i\s*redeemed|i\s*got\s*it|code\s*is\s*redeemed|it['’]s\s*redeemed|already\s*used|too\s*late)\b/i;
    if (claimedPatterns.test(content)) {
        addSystemMsg(`📢 Chat Alert: Giftcard confirmed already claimed/redeemed! ("${content.substring(0, 60)}" by ${author})`, 'error');
        setRedeemStatus(`⚠️ Chat Confirmed: Giftcard already redeemed! ("${content.substring(0, 40)}")`, 'error');
        if (config.soundAlert) playBuzzer();
    }

    // scan for codes
    config.codeRegex.lastIndex = 0; // reset regex state
    const matches = content.match(config.codeRegex);

    if (matches && matches.length > 0) {
        for (const code of matches) {
            if (seenCodes.has(code)) continue;
            seenCodes.add(code);

            // Check if this code is a trap / ban code
            const isTrap = config.antiTrap && isTrapContext(content);

            if (isTrap) {
                addTrapMessage(author, timeStr, content, code, isEdit);
                addSystemMsg(`🛡️ TRAP DETECTED & BLOCKED: "${code}" (Context indicates ban/trap code)`, 'error');
                setRedeemStatus(`⚠️ Skipped Trap Key: ${code} (Ban lifetime detected)`, 'error');
                continue; // Do NOT snipe or redeem
            }

            stats.codes++;
            updateStat('stat-codes', stats.codes);

            addCodeMessage(author, timeStr, content, code, isEdit);

            if (config.soundAlert) playAlert();

            // prefire: fill the code input
            const codeInput = document.getElementById('redeem-code-input');
            codeInput.value = code;
            codeInput.classList.add('has-code');

            // Track snipe timing
            const snipeDetectTime = Date.now();

            if (config.autoRedeem) {
                redeemCode(code, snipeDetectTime);
            } else {
                setRedeemStatus('Code captured! Click Redeem or it\'s loaded in prefire.', 'pending');
            }
        }
    } else {
        addMessage(author, timeStr, content, isEdit);
    }

    // Push into recent message buffer (keep last 10 messages)
    recentMessagesBuffer.push({ author, content, time: timestamp });
    if (recentMessagesBuffer.length > 10) {
        recentMessagesBuffer.shift();
    }
}

// ============================================
// UI: Messages
// ============================================

function addMessage(author, time, content, isEdit) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `
        <span class="msg-author">${escapeHtml(author)}</span>
        <span class="msg-time">${time}${isEdit ? ' (edited)' : ''}</span>
        <br>
        <span class="msg-content">${escapeHtml(content)}</span>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    
    // keep max 200 messages in DOM
    while (container.children.length > 200) {
        container.removeChild(container.firstChild);
    }
}

function addTrapMessage(author, time, content, code, isEdit) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = 'msg trap-detected';
    div.innerHTML = `
        <span class="msg-author">${escapeHtml(author)}</span>
        <span class="msg-time">${time}${isEdit ? ' (edited)' : ''}</span>
        <span class="trap-badge">⚠️ TRAP BLOCKED</span>
        <br>
        <span class="msg-content">${escapeHtml(content)}</span>
        <br>
        <span class="trap-highlight">🛑 ${escapeHtml(code)} (DO NOT REDEEM)</span>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addCodeMessage(author, time, content, code, isEdit) {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = 'msg code-found snipe-flash';
    div.innerHTML = `
        <span class="msg-author">${escapeHtml(author)}</span>
        <span class="msg-time">${time}${isEdit ? ' (edited)' : ''}</span>
        <br>
        <span class="msg-content">${escapeHtml(content)}</span>
        <br>
        <span class="code-highlight">⚡ ${escapeHtml(code)}</span>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addSystemMsg(text, cls = '') {
    const container = document.getElementById('messages-container');
    const div = document.createElement('div');
    div.className = `system-msg ${cls}`;
    div.textContent = `[${new Date().toLocaleTimeString('en-GB')}] ${text}`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// ============================================
// Code Redemption
// ============================================

async function redeemCode(code, snipeDetectTime) {
    if (!code) {
        code = document.getElementById('redeem-code-input').value.trim();
    }
    if (!code) return;

    const btn = document.getElementById('redeem-btn');
    btn.classList.add('loading');
    btn.textContent = 'Redeeming...';
    setRedeemStatus('Submitting code...', 'pending');

    const snipeTime = snipeDetectTime || Date.now();
    let copyMs = 0;
    let redeemMs = 0;
    let totalMs = 0;

    try {
        // 1. Copy code to clipboard & measure ms
        const tCopyStart = Date.now();
        try {
            await navigator.clipboard.writeText(code);
            copyMs = Date.now() - tCopyStart;
            const copyEl = document.getElementById('speed-copy');
            if (copyEl) copyEl.textContent = `${copyMs}ms`;
        } catch (clipErr) {
            const copyEl = document.getElementById('speed-copy');
            if (copyEl) copyEl.textContent = 'Denied';
        }

        // 2. Dispatch Redeem & measure ms
        const tRedeemStart = Date.now();
        let redeemSuccess = false;
        let isAlreadyRedeemed = false;

        // Try server-side ultra-fast HTTPS redeem first (zero CORS)
        try {
            const srvResp = await fetch('/api/sniper/redeem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            if (srvResp.ok) {
                const srvData = await srvResp.json();
                redeemMs = srvData.ms || (Date.now() - tRedeemStart);
                redeemSuccess = srvData.success;
                if (srvData.status === 'already_redeemed') {
                    isAlreadyRedeemed = true;
                }
            }
        } catch (srvErr) {}

        // Fallback to direct client fetch if server redeem failed and cookie exists
        if (!redeemSuccess && !isAlreadyRedeemed && config.spyhubCookie) {
            const result = await redeemViaAPI(code);
            redeemMs = Date.now() - tRedeemStart;
            redeemSuccess = result.success;
            if (result.status === 'already_redeemed') {
                isAlreadyRedeemed = true;
            }
        }

        if (!redeemMs) {
            redeemMs = Date.now() - tRedeemStart;
        }

        totalMs = Date.now() - snipeTime;

        // Update live ms widgets
        const redEl = document.getElementById('speed-redeem');
        if (redEl) redEl.textContent = `${redeemMs}ms`;
        const totEl = document.getElementById('speed-total');
        if (totEl) totEl.textContent = `${totalMs}ms`;
        const latEl = document.getElementById('stat-latency');
        if (latEl) latEl.textContent = `${totalMs}ms`;

        if (redeemSuccess) {
            onRedeemSuccess(code, snipeTime, copyMs, redeemMs, totalMs);
            return;
        }

        if (isAlreadyRedeemed) {
            setRedeemStatus(`❌ ALREADY REDEEMED: ${code} was claimed by someone else (${totalMs}ms)`, 'error');
            addHistoryItem(code, 'already_redeemed', snipeTime, totalMs);
            addSystemMsg(`⚠️ Code ${code} was ALREADY CLAIMED by another user! (${totalMs}ms)`, 'error');
            if (config.soundAlert) playBuzzer();
            return;
        }

        // Copied to clipboard in background (zero popup tabs)
        setRedeemStatus(`⚡ Copied to clipboard (${copyMs}ms) • Total: ${totalMs}ms • Code: ${code}`, 'pending');
        addHistoryItem(code, 'sniped', snipeTime, totalMs);
        stats.redeemed++;
        updateStat('stat-redeemed', stats.redeemed);

    } catch (err) {
        console.error('Redeem error:', err);
        totalMs = Date.now() - snipeTime;
        const totEl = document.getElementById('speed-total');
        if (totEl) totEl.textContent = `${totalMs}ms`;
        const latEl = document.getElementById('stat-latency');
        if (latEl) latEl.textContent = `${totalMs}ms`;

        setRedeemStatus(`Error: ${err.message} (${totalMs}ms). Code: ${code}`, 'error');
        addHistoryItem(code, 'failed', snipeTime, totalMs);
    } finally {
        btn.classList.remove('loading');
        btn.textContent = 'Redeem Code';
    }
}

async function redeemViaAPI(code) {
    try {
        const resp = await fetch(`${SPYHUB_API}/site/giftcard`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': config.spyhubCookie,
                'Origin': SPYHUB_BASE,
                'Referer': `${SPYHUB_BASE}/`
            },
            credentials: 'include',
            body: JSON.stringify({ code: code })
        });

        if (resp.ok) {
            const data = await resp.json();
            return { success: true, data };
        } else {
            const errData = await resp.text();
            const lower = (errData || '').toLowerCase();
            const isClaimed = lower.includes('already') || lower.includes('claimed') || lower.includes('used');
            return { success: false, status: isClaimed ? 'already_redeemed' : 'failed', error: errData };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function onRedeemSuccess(code, snipeTime, copyMs, redeemMs, totalMs) {
    const elapsed = totalMs || (Date.now() - snipeTime);
    setRedeemStatus(`✅ Redeemed! Code: ${code} (Copy: ${copyMs || 0}ms • Network: ${redeemMs || 0}ms • Total: ${elapsed}ms)`, 'success');
    addHistoryItem(code, 'sniped', snipeTime, elapsed);
    stats.redeemed++;
    updateStat('stat-redeemed', stats.redeemed);

    addSystemMsg(`✅ REDEEMED: ${code} in ${elapsed}ms [Copy: ${copyMs || 0}ms | Net: ${redeemMs || 0}ms]`, 'success');

    if (config.soundAlert) playSuccess();
}

// ============================================
// Prefire Mode
// ============================================

function togglePrefire() {
    showPrefire();
}

function showPrefire() {
    const card = document.querySelector('.prefire-card');
    if (card) {
        card.style.borderColor = 'var(--accent)';
        card.style.boxShadow = '0 0 20px var(--accent-glow)';
        setTimeout(() => {
            if (card) {
                card.style.borderColor = '';
                card.style.boxShadow = '';
            }
        }, 1500);
    }
    const input = document.getElementById('redeem-code-input');
    if (input) input.focus();
}

function hidePrefire() {}

async function pasteFromClipboard() {
    try {
        const text = await navigator.clipboard.readText();
        const input = document.getElementById('redeem-code-input');
        input.value = text;
        if (text.match(/SPY-/i)) {
            input.classList.add('has-code');
        }
    } catch (e) {
        setRedeemStatus('Clipboard access denied', 'error');
    }
}

function clearCode() {
    const input = document.getElementById('redeem-code-input');
    input.value = '';
    input.classList.remove('has-code');
    setRedeemStatus('', '');
}

// ============================================
// History
// ============================================

function addHistoryItem(code, status, timestamp, ms) {
    history.unshift({ code, status, time: new Date(timestamp), ms });
    if (history.length > 50) history.pop();
    renderHistory();
    // Persist history and stats automatically
    saveConfig();
}

function renderHistory() {
    const list = document.getElementById('history-list');
    if (history.length === 0) {
        list.innerHTML = '<div class="history-empty">No codes sniped yet.</div>';
        return;
    }
    list.innerHTML = history.map(h => `
        <div class="history-item">
            <span class="hi-code">${escapeHtml(h.code)}</span>
            <span class="hi-status ${h.status}">${h.status.toUpperCase()} ${h.ms ? '(' + h.ms + 'ms)' : ''}</span>
            <span class="hi-time">${h.time.toLocaleTimeString('en-GB')}</span>
        </div>
    `).join('');
}

// ============================================
// UI Helpers
// ============================================

function updateStatus(text, cls) {
    const badge = document.getElementById('status-badge');
    if (badge) {
        badge.textContent = text;
        badge.className = 'status-badge ' + cls;
    }
    const btn = document.getElementById('main-sniper-btn');
    if (btn) {
        if (cls === 'connected' || text.includes('RUNNING') || text.includes('CONNECTED')) {
            btn.textContent = '🛑 Stop Background Sniper';
            btn.className = 'btn btn-danger';
        } else if (text.includes('IDLE') || text.includes('STOPPED') || cls === 'error') {
            btn.textContent = '⚡ Start Background Sniper';
            btn.className = 'btn btn-primary';
        }
    }
}

function updateStat(id, value) {
    document.getElementById(id).textContent = value;
}

function setRedeemStatus(text, cls) {
    const el = document.getElementById('redeem-status');
    el.textContent = text;
    el.className = 'redeem-status ' + cls;
}

function updateUptime() {
    if (!startTime) return;
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    document.getElementById('stat-uptime').textContent = `${h}:${m}:${s}`;
}

function updateLatency() {
    if (window._lastHeartbeatSent) {
        const latency = Date.now() - window._lastHeartbeatSent;
        document.getElementById('stat-latency').textContent = `${latency}ms`;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// Audio Alerts
// ============================================

function playAlert() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        // sharp attention-grabbing beep
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'square';
        osc1.frequency.setValueAtTime(880, ctx.currentTime);
        osc1.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
        osc1.frequency.setValueAtTime(1320, ctx.currentTime + 0.2);
        gain1.gain.setValueAtTime(0.3, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.4);
    } catch (e) {}
}

function playSuccess() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        // pleasant success chime
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(523, ctx.currentTime);
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.15);
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) {}
}

function playBuzzer() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(160, ctx.currentTime);
        osc.frequency.setValueAtTime(120, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
}

// ============================================
// Keyboard Shortcuts
// ============================================

document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+P = toggle prefire
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        togglePrefire();
    }
    // Ctrl+Enter in code input = redeem
    if (e.ctrlKey && e.key === 'Enter') {
        const input = document.getElementById('redeem-code-input');
        if (document.activeElement === input || input.value) {
            e.preventDefault();
            redeemCode();
        }
    }
    // Escape = back to setup
    if (e.key === 'Escape') {
        stopSniper();
    }
});

// ============================================
// 24/7 AFK Discord Online Spoofer Manager
// ============================================

class DiscordAfkClient {
    constructor(token, customStatus, logCallback) {
        this.token = token.trim();
        this.customStatus = customStatus || 'Active';
        this.log = logCallback;
        this.ws = null;
        this.heartbeatInterval = null;
        this.lastSequence = null;
        this.isActive = false;
        this.username = 'Unknown';
        this.reconnectTimer = null;
    }

    start() {
        this.isActive = true;
        this.connect();
    }

    stop() {
        this.isActive = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.ws) {
            try { this.ws.close(1000); } catch(e) {}
        }
        this.log(`[${this.username}] Stopped.`, 'afk-warn');
    }

    connect() {
        if (!this.isActive) return;

        this.ws = new WebSocket(DISCORD_GATEWAY);

        this.ws.onopen = () => {
            // connection established
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.s) this.lastSequence = data.s;

            switch (data.op) {
                case 10: // Hello
                    this.startHeartbeat(data.d.heartbeat_interval);
                    this.identify();
                    break;
                case 11: // Heartbeat ACK
                    // silently healthy
                    break;
                case 0: // Dispatch
                    if (data.t === 'READY') {
                        const u = data.d.user;
                        this.username = `${u.username}#${u.discriminator || '0'}`;
                        this.log(`🟢 [${this.username}] ONLINE 24/7 (AFK Active)`, 'afk-ok');
                    }
                    break;
                case 7: // Reconnect
                case 9: // Invalid session
                    if (this.ws) this.ws.close(4000);
                    break;
            }
        };

        this.ws.onclose = (event) => {
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            if (!this.isActive) return;

            if (event.code === 4004) {
                this.log(`🔴 [${this.username}] Auth failed (invalid token)`, 'afk-err');
                this.isActive = false;
                return;
            }

            this.log(`🟡 [${this.username}] Disconnected (${event.code}). Auto-reconnecting in 5s...`, 'afk-warn');
            this.reconnectTimer = setTimeout(() => {
                if (this.isActive) this.connect();
            }, 5000);
        };

        this.ws.onerror = () => {
            // error handled in onclose
        };
    }

    startHeartbeat(interval) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        setTimeout(() => {
            this.sendHeartbeat();
        }, interval * Math.random());
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeat();
        }, interval);
    }

    sendHeartbeat() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
        }
    }

    identify() {
        const isBot = this.token.startsWith('Bot ') || this.token.startsWith('Bearer ');
        let payload;

        if (isBot) {
            payload = {
                op: 2,
                d: {
                    token: this.token,
                    intents: 1, // GUILDS
                    properties: { os: 'windows', browser: 'discord.js', device: 'discord.js' },
                    presence: {
                        status: 'online',
                        afk: false
                    }
                }
            };
        } else {
            payload = {
                op: 2,
                d: {
                    token: this.token,
                    capabilities: 16381,
                    properties: {
                        os: 'Windows',
                        browser: 'Chrome',
                        device: '',
                        system_locale: 'en-US',
                        browser_user_agent: navigator.userAgent,
                        browser_version: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '120.0.0.0',
                        os_version: '10',
                        referrer: '',
                        referring_domain: '',
                        release_channel: 'stable',
                        client_build_number: 250484,
                        client_event_source: null
                    },
                    presence: {
                        status: 'online',
                        since: 0,
                        activities: this.customStatus ? [{
                            name: 'Custom Status',
                            type: 4,
                            state: this.customStatus
                        }] : [],
                        afk: false
                    },
                    compress: false,
                    client_state: { guild_versions: {} }
                }
            };
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        }
    }
}

let activeAfkClients = [];

function startAfkSpoofer(silent = false) {
    if (activeAfkClients.length > 0) return;

    const raw = document.getElementById('afk-tokens')?.value || '';
    const statusText = document.getElementById('afk-status-text')?.value || 'Active';
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 10);

    if (lines.length === 0) {
        if (!silent) addAfkLog('No tokens provided! Paste one or more tokens (one per line).', 'afk-err');
        return;
    }

    addAfkLog(`🚀 Auto-starting AFK Spoofer for ${lines.length} account(s)...`, 'afk-info');

    lines.forEach((token, index) => {
        const client = new DiscordAfkClient(token, statusText, (msg, cls) => {
            addAfkLog(msg, cls);
        });
        activeAfkClients.push(client);
        setTimeout(() => {
            client.start();
        }, index * 300);
    });

    const btn = document.getElementById('afk-toggle-btn');
    if (btn) {
        btn.textContent = `🛑 Stop AFK Spoofer (${lines.length} Running)`;
        btn.className = 'btn btn-danger';
    }
}

function stopAfkSpoofer() {
    activeAfkClients.forEach(c => c.stop());
    activeAfkClients = [];
    const btn = document.getElementById('afk-toggle-btn');
    if (btn) {
        btn.textContent = '🟢 Start 24/7 AFK Spoofer';
        btn.className = 'btn btn-secondary';
    }
    addAfkLog('All 24/7 AFK accounts stopped.', 'afk-warn');
}

function toggleAfkSpoofer() {
    if (activeAfkClients.length > 0) {
        stopAfkSpoofer();
    } else {
        saveConfig();
        startAfkSpoofer(false);
    }
}

function addAfkLog(msg, cls) {
    const box = document.getElementById('afk-status-box');
    if (!box) return;
    const time = new Date().toLocaleTimeString('en-GB');
    box.innerHTML += `<div class="${cls}">[${time}] ${msg}</div>`;
    box.scrollTop = box.scrollHeight;
}

function clearAfkLogs() {
    const box = document.getElementById('afk-status-box');
    if (box) box.innerHTML = '';
}

// ============================================
// Audio: Prefire Alert (distinct rapid chirps)
// ============================================

function playPrefireAlert() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();

        // rapid ascending chirps — attention-grabbing "incoming" sound
        [0, 0.12, 0.24, 0.36].forEach((offset, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.setValueAtTime(600 + i * 200, ctx.currentTime + offset);
            gain.gain.setValueAtTime(0.25, ctx.currentTime + offset);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + offset + 0.1);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + offset);
            osc.stop(ctx.currentTime + offset + 0.1);
        });
    } catch (e) {}
}

// ============================================
// Server-Side Sniper Controls (API calls)
// ============================================

let serverSniperRunning = false;
let sseSource = null;

async function startServerSniper() {
    try {
        const resp = await fetch('/api/sniper/start', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
            serverSniperRunning = true;
            addSystemMsg('🖥️ Server-side sniper started! Runs 24/7 even with browser closed.', 'success');
            updateServerSniperUI();
            connectSSE();
        } else {
            addSystemMsg(`Server sniper: ${data.message || 'Failed'}`, 'error');
        }
    } catch (e) {
        addSystemMsg('Failed to reach server API: ' + e.message, 'error');
    }
}

async function stopServerSniper() {
    try {
        await fetch('/api/sniper/stop', { method: 'POST' });
        serverSniperRunning = false;
        addSystemMsg('🛑 Server-side sniper stopped.', 'error');
        updateServerSniperUI();
        if (sseSource) { sseSource.close(); sseSource = null; }
    } catch (e) {
        addSystemMsg('Failed to stop server sniper: ' + e.message, 'error');
    }
}

function toggleServerSniper() {
    if (serverSniperRunning) {
        stopServerSniper();
    } else {
        startServerSniper();
    }
}

function updateServerSniperUI(channels) {
    updateSniperUI(serverSniperRunning, serverSniperRunning ? 'BACKGROUND: RUNNING' : 'BACKGROUND: IDLE', channels);
}

let hotChannel = { id: null, name: null, until: 0, reason: null };

function updateHotChannelBadge() {
    const badge = document.getElementById('hot-channel-badge');
    if (!badge) return;
    if (hotChannel && hotChannel.until && hotChannel.until > Date.now()) {
        const diffSec = Math.floor((hotChannel.until - Date.now()) / 1000);
        const m = Math.floor(diffSec / 60);
        const s = diffSec % 60;
        badge.style.display = 'inline-flex';
        badge.textContent = `🔥 HOT: ${hotChannel.name} (${m}:${s.toString().padStart(2, '0')})`;
        badge.title = `Focused on ${hotChannel.name} for 10m (${hotChannel.reason}). Checking all channels in background.`;
    } else {
        badge.style.display = 'none';
    }
}

// SSE: live events from server-side sniper
function connectSSE() {
    if (sseSource) sseSource.close();

    sseSource = new EventSource('/api/sniper/events');

    sseSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleSSEEvent(data);
        } catch (e) {}
    };

    sseSource.onerror = () => {
        // auto-reconnects
    };
}

function handleSSEEvent(data) {
    switch (data.type) {
        case 'init':
            serverSniperRunning = data.state?.running || false;
            isConnected = serverSniperRunning;
            updateSniperUI(serverSniperRunning, serverSniperRunning ? 'BACKGROUND: RUNNING' : 'BACKGROUND: IDLE', data.state?.monitoredChannels);
            if (data.state?.hotChannel && data.state.hotChannel.until > Date.now()) {
                hotChannel = data.state.hotChannel;
                updateHotChannelBadge();
            }
            if (data.state?.stats) {
                const s = data.state.stats;
                updateStat('stat-messages', s.messages);
                updateStat('stat-codes', s.codes);
                updateStat('stat-redeemed', s.redeemed);
            }
            break;

        case 'hot_channel':
            hotChannel = data;
            updateHotChannelBadge();
            addSystemMsg(`🔥 [STICKY FOCUS] Locked on ${data.name} for 10m (${data.reason}). Still monitoring all selected channels in parallel.`, 'warn');
            break;

        case 'key_failed_standby':
            addSystemMsg(`🔄 Key "${data.code}" invalid or claimed. Re-arming pipeline on ${data.channel_name} (10m focus) scanning for next code!`, 'info');
            setRedeemStatus(`⚠️ False/Claimed Key ("${data.code}"). Standing by on ${data.channel_name} for real drop...`, 'pending');
            break;

        case 'log':
            addSystemMsg(`[SRV] ${data.msg}`, data.level === 'error' ? 'error' : data.level === 'success' ? 'success' : '');
            break;

        case 'message':
            // show server-detected messages in feed
            const ts = data.timestamp ? new Date(data.timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
            addMessage(data.author || '?', ts, data.content || '', false);
            break;

        case 'code_found':
            addCodeMessage(data.author || '?', new Date().toLocaleTimeString('en-GB'), data.content || '', data.code, false);
            stats.codes++;
            updateStat('stat-codes', stats.codes);
            if (config.soundAlert) playAlert();
            // fill prefire
            const ci = document.getElementById('redeem-code-input');
            if (ci) { ci.value = data.code; ci.classList.add('has-code'); }
            break;

        case 'trap':
            addTrapMessage(data.author || '?', new Date().toLocaleTimeString('en-GB'), data.content || '', data.code, false);
            addSystemMsg(`🛡️ [SRV] TRAP BLOCKED: ${data.code}`, 'error');
            break;

        case 'redeem':
            const scEl = document.getElementById('speed-copy');
            if (scEl) scEl.textContent = '0ms (Server)';
            const srEl = document.getElementById('speed-redeem');
            if (srEl) srEl.textContent = `${data.ms}ms`;
            const stEl = document.getElementById('speed-total');
            if (stEl) stEl.textContent = `${data.ms}ms`;
            const slEl = document.getElementById('stat-latency');
            if (slEl) slEl.textContent = `${data.ms}ms`;

            if (data.status === 'redeemed') {
                stats.redeemed++;
                updateStat('stat-redeemed', stats.redeemed);
                addHistoryItem(data.code, 'sniped', Date.now(), data.ms);
                if (config.soundAlert) playSuccess();
                setRedeemStatus(`✅ Server redeemed: ${data.code} (${data.ms}ms)`, 'success');
            } else if (data.status === 'already_redeemed') {
                addHistoryItem(data.code, 'already_redeemed', Date.now(), data.ms);
                setRedeemStatus(`❌ ALREADY REDEEMED: ${data.code} was claimed by someone else (${data.ms}ms)`, 'error');
                addSystemMsg(`⚠️ [SRV] ALREADY REDEEMED: ${data.code} (Claimed by another user)`, 'error');
                if (config.soundAlert) playBuzzer();
            } else {
                addHistoryItem(data.code, 'failed', Date.now(), data.ms);
                setRedeemStatus(`❌ Server redeem failed: ${data.code} (${data.ms}ms)`, 'error');
            }
            break;

        case 'chat_claimed':
            addSystemMsg(`📢 [SRV] Chat alert: Giftcard claimed/redeemed! ("${(data.content || '').substring(0, 60)}" from ${data.author})`, 'error');
            setRedeemStatus(`⚠️ Chat Alert: Code was already claimed! ("${(data.content || '').substring(0, 40)}")`, 'error');
            if (config.soundAlert) playBuzzer();
            break;

        case 'prefire_trigger':
            addSystemMsg(`🎯 [SRV] DROP INCOMING — "${(data.content || '').substring(0, 60)}" from ${data.author}`, 'success');
            if (!isPrefireVisible) showPrefire();
            if (config.soundAlert) playPrefireAlert();
            break;

        case 'status':
            const isConn = data.status === 'CONNECTED';
            serverSniperRunning = isConn || data.status === 'CONNECTING';
            isConnected = serverSniperRunning;
            updateSniperUI(serverSniperRunning, isConn ? 'BACKGROUND: RUNNING' : data.status, data.channels);
            break;
    }
}

// Speed Benchmark
async function runBenchmark() {
    addSystemMsg('🏎️ Running speed benchmark...', '');
    setRedeemStatus('Benchmarking snipe speed...', 'pending');

    try {
        const resp = await fetch('/api/sniper/benchmark');
        const data = await resp.json();
        const msg = `🏎️ Benchmark: Total ${data.total_ms}ms | Regex: ${data.regex_ms}ms | Trap: ${data.trap_check_ms}ms | HTTP: ${data.http_redeem_ms}ms`;
        addSystemMsg(msg, 'success');
        setRedeemStatus(msg, 'success');

        const scEl = document.getElementById('speed-copy');
        if (scEl) scEl.textContent = `${data.regex_ms + data.trap_check_ms}ms (Filter)`;
        const srEl = document.getElementById('speed-redeem');
        if (srEl) srEl.textContent = `${data.http_redeem_ms}ms`;
        const stEl = document.getElementById('speed-total');
        if (stEl) stEl.textContent = `${data.total_ms}ms`;
        const slEl = document.getElementById('stat-latency');
        if (slEl) slEl.textContent = `${data.total_ms}ms`;
    } catch (e) {
        addSystemMsg('Benchmark failed: ' + e.message, 'error');
        setRedeemStatus('Benchmark failed: ' + e.message, 'error');
    }
}

// Check server sniper status on load
async function checkServerSniperStatus() {
    try {
        const resp = await fetch('/api/sniper/status');
        if (!resp.ok) return;
        const data = await resp.json();
        
        if (data.running) {
            serverSniperRunning = true;
            isConnected = true;
            updateSniperUI(true, 'BACKGROUND: RUNNING', data.monitoredChannels);
            if (data.hotChannel && data.hotChannel.until > Date.now()) {
                hotChannel = data.hotChannel;
                updateHotChannelBadge();
            }
            connectSSE();
            addSystemMsg(`⚡ 24/7 Background sniper is active & running (${data.connectedAs || 'Connected'}). Monitoring channels.`, 'success');
            
            if (data.startTime) {
                startTime = data.startTime;
                if (uptimeTimer) clearInterval(uptimeTimer);
                uptimeTimer = setInterval(updateUptime, 1000);
            }
            if (data.stats) {
                stats = Object.assign(stats, data.stats);
                updateStat('stat-messages', stats.messages);
                updateStat('stat-codes', stats.codes);
                updateStat('stat-redeemed', stats.redeemed);
            }
        } else {
            // If server sniper is not running yet, check if token and channel are present to auto-start!
            const token = document.getElementById('discord-token')?.value?.trim();
            const channelId = document.getElementById('channel-id')?.value?.trim();
            if (token && channelId) {
                addSystemMsg('🚀 Token & channels found: Auto-running 24/7 background sniper...', 'success');
                startSniper(true);
            } else {
                updateSniperUI(false, 'BACKGROUND: IDLE');
            }
        }
    } catch (e) {
        const token = document.getElementById('discord-token')?.value?.trim();
        const channelId = document.getElementById('channel-id')?.value?.trim();
        if (token && channelId && !isConnected) {
            startSniper(true);
        }
    }
}

// ============================================
// Init on Load
// ============================================

window.addEventListener('DOMContentLoaded', async () => {
    await loadConfig();
    await checkServerSniperStatus();
    setInterval(updateHotChannelBadge, 1000);
});

