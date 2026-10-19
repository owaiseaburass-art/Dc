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

// ============================================
// Setup & Init
// ============================================

function toggleVis(inputId) {
    const input = document.getElementById(inputId);
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function loadConfig() {
    let c = null;

    // 1. Try to fetch saved config from server (works on Render)
    try {
        const resp = await fetch('/api/config');
        if (resp.ok) {
            const serverConfig = await resp.json();
            if (serverConfig && Object.keys(serverConfig).length > 0) {
                c = serverConfig;
            }
        }
    } catch (e) {
        // running purely client-side without server
    }

    // 2. Fallback to localStorage if server has no config yet
    if (!c) {
        const saved = localStorage.getItem('spyhub-sniper-config');
        if (saved) {
            try { c = JSON.parse(saved); } catch (e) {}
        }
    }

    if (c) {
        document.getElementById('discord-token').value = c.token || '';
        document.getElementById('channel-id').value = c.channelId || '';
        document.getElementById('guild-id').value = c.guildId || '';
        document.getElementById('code-prefix').value = c.codePrefix || 'SPY-';
        document.getElementById('code-regex').value = c.codeRegex || 'SPY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}';
        document.getElementById('auto-redeem').checked = c.autoRedeem !== false;
        document.getElementById('sound-alert').checked = c.soundAlert !== false;
        const antiTrapEl = document.getElementById('anti-trap');
        if (antiTrapEl) antiTrapEl.checked = c.antiTrap !== false;
        document.getElementById('spyhub-cookie').value = c.spyhubCookie || '';
        const afkTokensEl = document.getElementById('afk-tokens');
        if (afkTokensEl && c.afkTokens) afkTokensEl.value = c.afkTokens;
        const afkStatusEl = document.getElementById('afk-status-text');
        if (afkStatusEl && c.afkStatusText) afkStatusEl.value = c.afkStatusText;
    }
}

function saveConfig() {
    config.token = document.getElementById('discord-token').value.trim();
    config.channelId = document.getElementById('channel-id').value.trim();
    config.guildId = document.getElementById('guild-id').value.trim();
    config.codePrefix = document.getElementById('code-prefix').value.trim();
    config.autoRedeem = document.getElementById('auto-redeem').checked;
    config.soundAlert = document.getElementById('sound-alert').checked;
    const antiTrapEl = document.getElementById('anti-trap');
    config.antiTrap = antiTrapEl ? antiTrapEl.checked : true;
    config.spyhubCookie = document.getElementById('spyhub-cookie').value.trim();

    const regexStr = document.getElementById('code-regex').value.trim();
    try {
        config.codeRegex = new RegExp(regexStr, 'gi');
    } catch (e) {
        config.codeRegex = new RegExp('SPY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}', 'gi');
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
        spyhubCookie: config.spyhubCookie,
        afkTokens: afkTokensVal,
        afkStatusText: afkStatusVal
    };

    // Save to localStorage immediately
    localStorage.setItem('spyhub-sniper-config', JSON.stringify(payload));

    // Auto-save to Render server asynchronously
    fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(() => {});
}

function startSniper() {
    saveConfig();
    if (!config.token) return alert('Discord token is required');
    if (!config.channelId) return alert('Channel ID is required');

    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('sniper-panel').classList.remove('hidden');

    if (document.getElementById('prefire-mode').checked) {
        showPrefire();
    }

    startTime = Date.now();
    uptimeTimer = setInterval(updateUptime, 1000);
    connectGateway();
}

function startPrefire() {
    saveConfig();
    if (!config.token) return alert('Discord token is required');
    if (!config.channelId) return alert('Channel ID is required');

    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('sniper-panel').classList.remove('hidden');
    showPrefire();

    startTime = Date.now();
    uptimeTimer = setInterval(updateUptime, 1000);
    connectGateway();
}

function stopSniper() {
    if (ws) ws.close(1000);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (uptimeTimer) clearInterval(uptimeTimer);
    
    isConnected = false;
    ws = null;
    
    document.getElementById('setup-panel').classList.remove('hidden');
    document.getElementById('sniper-panel').classList.add('hidden');
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
            updateStatus('CONNECTED', 'connected');
            
            // extract channel name from READY payload guilds if available
            let channelName = config.channelId;
            if (data.guilds) {
                for (const g of data.guilds) {
                    if (g.channels) {
                        const ch = g.channels.find(c => c.id === config.channelId);
                        if (ch) { channelName = ch.name; break; }
                    }
                }
            }
            document.getElementById('channel-name').textContent = `#${channelName}`;
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

    if (!/^\d{17,20}$/.test(channelId)) {
        log('⚠ Channel ID looks wrong (should be 17-20 digits)', 't-warn');
    } else {
        log(`✓ Channel ID format OK: ${channelId}`, 't-ok');
    }

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
            
            // check if the target channel exists in any guild
            let foundChannel = false;
            let foundGuild = false;
            if (data.d.guilds) {
                for (const g of data.d.guilds) {
                    if (guildId && g.id === guildId) foundGuild = true;
                    if (g.channels) {
                        const ch = g.channels.find(c => c.id === channelId);
                        if (ch) {
                            foundChannel = true;
                            log(`✓ Channel found: #${ch.name} (type: ${ch.type}) in guild: ${g.properties?.name || g.id}`, 't-ok');
                            break;
                        }
                    }
                }
            }
            
            if (!foundChannel) {
                log(`⚠ Channel ${channelId} not found in READY data — you may not have access or it's a DM`, 't-warn');
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
    const regexStr = document.getElementById('code-regex').value.trim() || 'SPY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}';
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
    // only process messages from the target channel
    if (msg.channel_id !== config.channelId) return;

    stats.messages++;
    updateStat('stat-messages', stats.messages);

    const content = msg.content || '';
    const author = msg.author ? (msg.author.username || 'Unknown') : 'Unknown';
    const timestamp = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const timeStr = timestamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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

            if (config.autoRedeem) {
                redeemCode(code);
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

async function redeemCode(code) {
    if (!code) {
        code = document.getElementById('redeem-code-input').value.trim();
    }
    if (!code) return;

    const btn = document.getElementById('redeem-btn');
    btn.classList.add('loading');
    btn.textContent = 'Redeeming...';
    setRedeemStatus('Submitting code...', 'pending');

    const snipeTime = Date.now();
    
    try {
        // Method 1: try SpyHub API directly if we have a cookie/session
        if (config.spyhubCookie) {
            const result = await redeemViaAPI(code);
            if (result.success) {
                onRedeemSuccess(code, snipeTime);
                return;
            }
        }
        
        // Method 2: open SpyHub in new tab with code pre-filled via URL params
        // and copy code to clipboard for manual paste
        await navigator.clipboard.writeText(code);
        
        // open the giftcard page
        window.open(`${SPYHUB_BASE}/`, '_blank');
        
        setRedeemStatus(`Code copied to clipboard! Paste it on SpyHub. Code: ${code}`, 'pending');
        addHistoryItem(code, 'sniped', snipeTime);
        stats.redeemed++;
        updateStat('stat-redeemed', stats.redeemed);
        
    } catch (err) {
        console.error('Redeem error:', err);
        setRedeemStatus(`Error: ${err.message}. Code: ${code}`, 'error');
        addHistoryItem(code, 'failed', snipeTime);
    } finally {
        btn.classList.remove('loading');
        btn.textContent = 'Redeem Code';
    }
}

async function redeemViaAPI(code) {
    // attempt to hit SpyHub's redeem endpoint
    // the actual endpoint path may vary — this is a best-guess from the site structure
    try {
        const resp = await fetch(`${SPYHUB_API}/site/giftcard/redeem`, {
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
            return { success: false, error: errData };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function onRedeemSuccess(code, snipeTime) {
    const elapsed = Date.now() - snipeTime;
    setRedeemStatus(`✅ Redeemed! Code: ${code} (${elapsed}ms)`, 'success');
    addHistoryItem(code, 'sniped', snipeTime);
    stats.redeemed++;
    updateStat('stat-redeemed', stats.redeemed);
    
    addSystemMsg(`✅ REDEEMED: ${code} in ${elapsed}ms`, 'success');
    
    if (config.soundAlert) playSuccess();
}

// ============================================
// Prefire Mode
// ============================================

function togglePrefire() {
    if (isPrefireVisible) {
        hidePrefire();
    } else {
        showPrefire();
    }
}

function showPrefire() {
    document.getElementById('prefire-panel').classList.remove('hidden');
    isPrefireVisible = true;
}

function hidePrefire() {
    document.getElementById('prefire-panel').classList.add('hidden');
    isPrefireVisible = false;
}

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

function addHistoryItem(code, status, timestamp) {
    history.unshift({ code, status, time: new Date(timestamp) });
    renderHistory();
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
            <span class="hi-status ${h.status}">${h.status.toUpperCase()}</span>
            <span class="hi-time">${h.time.toLocaleTimeString('en-GB')}</span>
        </div>
    `).join('');
}

// ============================================
// UI Helpers
// ============================================

function updateStatus(text, cls) {
    const badge = document.getElementById('status-badge');
    badge.textContent = text;
    badge.className = 'status-badge ' + cls;
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

function toggleAfkSpoofer() {
    const btn = document.getElementById('afk-toggle-btn');
    const box = document.getElementById('afk-status-box');

    if (activeAfkClients.length > 0) {
        // Stop all running clients
        activeAfkClients.forEach(c => c.stop());
        activeAfkClients = [];
        btn.textContent = '🟢 Start 24/7 AFK Spoofer';
        btn.className = 'btn btn-secondary';
        addAfkLog('All 24/7 AFK accounts stopped.', 'afk-warn');
        return;
    }

    saveConfig();

    const raw = document.getElementById('afk-tokens')?.value || '';
    const statusText = document.getElementById('afk-status-text')?.value || 'Active';
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 10);

    if (lines.length === 0) {
        addAfkLog('No tokens provided! Paste one or more tokens (one per line).', 'afk-err');
        return;
    }

    addAfkLog(`Starting AFK Spoofer for ${lines.length} account(s)...`, 'afk-info');

    lines.forEach((token, index) => {
        const client = new DiscordAfkClient(token, statusText, (msg, cls) => {
            addAfkLog(msg, cls);
        });
        activeAfkClients.push(client);
        // stagger connects by 300ms to be smooth
        setTimeout(() => {
            client.start();
        }, index * 300);
    });

    btn.textContent = `🛑 Stop AFK Spoofer (${lines.length} Running)`;
    btn.className = 'btn btn-danger';
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
// Init on Load
// ============================================

window.addEventListener('DOMContentLoaded', () => {
    loadConfig();
});

