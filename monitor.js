// ============================================
// Discord Drop Monitor & Clipboard Copier (Client)
// ============================================

let isRunning = false;
let sseSource = null;
let messageCount = 0;
let codesHistory = [];

document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    initSSE();
});

// ============================================
// Server-Sent Events (SSE) Stream
// ============================================

function initSSE() {
    if (sseSource) sseSource.close();
    sseSource = new EventSource('/api/monitor/events');

    sseSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleSSEEvent(data);
        } catch (e) {}
    };

    sseSource.onerror = () => {
        updateStatusBadge('RECONNECTING...', 'warning');
    };
}

function handleSSEEvent(data) {
    switch (data.type) {
        case 'init': {
            const s = data.state || {};
            isRunning = s.running || false;
            updateStatusBadge(s.status || (isRunning ? 'ONLINE 24/7' : 'IDLE'), isRunning ? 'success' : 'default');
            updateHeaderUser(s.user);
            updateMonitoredChannels(s.monitoredChannels);
            if (s.stats) {
                updateStat('stat-codes', s.stats.codesCopied || s.stats.codes || 0);
            }
            if (s.lastCopiedCode) {
                setLatestCopied(s.lastCopiedCode);
            }
            if (Array.isArray(s.recentMessages)) {
                s.recentMessages.forEach(m => renderMessage(m, false));
            }
            if (Array.isArray(s.recentCodes)) {
                codesHistory = s.recentCodes;
                renderCodesHistory();
            }
            updateToggleButton(isRunning);
            break;
        }

        case 'ready': {
            isRunning = true;
            updateStatusBadge(`ONLINE 24/7 (${(data.presenceStatus || 'online').toUpperCase()})`, 'success');
            updateHeaderUser(data.user);
            updateMonitoredChannels(data.channels);
            updateToggleButton(true);
            addSystemMsg(`✅ Connected as ${data.user?.username || 'User'} — AFK 24/7 is ACTIVE.`, 'success');
            break;
        }

        case 'status': {
            const st = data.status || 'IDLE';
            if (st === 'ONLINE_24_7') {
                isRunning = true;
                updateStatusBadge('ONLINE 24/7', 'success');
            } else if (st === 'CONNECTING') {
                updateStatusBadge('CONNECTING...', 'warning');
            } else if (st === 'RECONNECTING') {
                updateStatusBadge('RECONNECTING...', 'warning');
            } else if (st === 'AUTH_FAILED') {
                isRunning = false;
                updateStatusBadge('AUTH FAILED', 'danger');
                addSystemMsg('❌ Discord Token Invalid / Expired (4004)! Please update token in settings.', 'danger');
            } else if (st === 'NO_TOKEN') {
                isRunning = false;
                updateStatusBadge('NO TOKEN', 'danger');
            } else {
                isRunning = false;
                updateStatusBadge('IDLE', 'default');
            }
            updateToggleButton(isRunning);
            break;
        }

        case 'message': {
            renderMessage(data, true);
            break;
        }

        case 'code_found': {
            onCodeDetected(data);
            break;
        }

        case 'log': {
            if (data.level === 'error') {
                addSystemMsg(`[SRV] ${data.msg}`, 'danger');
            }
            break;
        }
    }
}

// ============================================
// UI Updates
// ============================================

function updateStatusBadge(text, type = 'default') {
    const badge = document.getElementById('status-badge');
    if (!badge) return;
    badge.textContent = text;
    badge.className = 'status-badge ' + (type === 'success' ? 'connected' : type === 'warning' ? 'connecting' : type === 'danger' ? 'error' : '');
}

function updateHeaderUser(user) {
    const el = document.getElementById('header-user');
    if (!el) return;
    if (user && user.username) {
        el.textContent = `${user.username}`;
        el.style.color = 'var(--text-primary)';
    } else {
        el.textContent = 'Not Connected';
        el.style.color = 'var(--text-muted)';
    }
}

function updateMonitoredChannels(channels) {
    const el = document.getElementById('channel-name');
    if (!el) return;
    if (channels && channels.length > 0) {
        el.textContent = `${channels.length} channel(s)`;
        el.title = channels.join(', ');
    } else {
        el.textContent = '#none';
    }
}

function updateStat(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function updateToggleButton(running) {
    const btn = document.getElementById('main-toggle-btn');
    if (!btn) return;
    if (running) {
        btn.textContent = '🛑 Stop Monitor';
        btn.className = 'btn btn-danger';
    } else {
        btn.textContent = '⚡ Start Monitor';
        btn.className = 'btn btn-primary';
    }
}

function setLatestCopied(code) {
    const el = document.getElementById('latest-code-display');
    if (el) {
        el.textContent = code;
        el.style.color = 'var(--success)';
    }
    const tag = document.getElementById('copy-status-tag');
    if (tag) {
        tag.textContent = '✓ COPIED (Ctrl+V Ready)';
        tag.style.background = 'rgba(16, 185, 129, 0.2)';
        tag.style.color = 'var(--success)';
        tag.style.borderColor = 'var(--success)';
    }
}

// ============================================
// Message Feed Rendering
// ============================================

function renderMessage(msg, autoScroll = true) {
    const feed = document.getElementById('message-feed');
    if (!feed) return;

    // Remove placeholder
    const placeholder = feed.querySelector('.feed-placeholder');
    if (placeholder) placeholder.remove();

    messageCount++;
    const countEl = document.getElementById('feed-count');
    if (countEl) countEl.textContent = `${messageCount} msgs`;

    const div = document.createElement('div');
    div.className = 'message-item' + (msg.isTrigger ? ' highlight-trigger' : '');

    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('en-GB') : new Date().toLocaleTimeString('en-GB');

    div.innerHTML = `
        <div class="message-meta">
            <span class="message-channel">${escapeHtml(msg.channel || '')}</span>
            <span class="message-author">${escapeHtml(msg.author || 'Unknown')}</span>
            <span class="message-time">${time}</span>
            ${msg.isTrigger ? '<span class="badge badge-warning" style="margin-left:6px">🎯 DROP ALERT</span>' : ''}
        </div>
        <div class="message-body">${formatMessageContent(msg.content || '')}</div>
    `;

    feed.appendChild(div);

    // Limit buffer in DOM
    while (feed.children.length > 100) {
        feed.removeChild(feed.firstChild);
    }

    if (autoScroll) {
        feed.scrollTop = feed.scrollHeight;
    }
}

function onCodeDetected(data) {
    const code = data.code;
    setLatestCopied(code);

    // Update stats
    const statEl = document.getElementById('stat-codes');
    if (statEl) {
        const cur = parseInt(statEl.textContent || '0', 10);
        statEl.textContent = cur + 1;
    }

    // Client-side fallback copy
    copyToBrowserClipboard(code);

    // Audio Alert
    const snd = document.getElementById('snd-alert');
    const chk = document.getElementById('sound-alert');
    if (snd && (!chk || chk.checked)) {
        try {
            snd.currentTime = 0;
            snd.play().catch(() => {});
        } catch (e) {}
    }

    // Add highlighted drop item into feed
    const feed = document.getElementById('message-feed');
    if (feed) {
        const dropDiv = document.createElement('div');
        dropDiv.className = 'message-item message-code-drop';
        dropDiv.style.background = 'rgba(124, 58, 237, 0.15)';
        dropDiv.style.border = '1px solid var(--accent)';
        dropDiv.style.padding = '12px 14px';
        dropDiv.style.margin = '8px 0';
        dropDiv.style.borderRadius = '8px';

        dropDiv.innerHTML = `
            <div class="message-meta">
                <span class="badge badge-success" style="font-weight:700">⚡ KEY DROPPED & COPIED</span>
                <span class="message-channel">${escapeHtml(data.channel || '')}</span>
                <span class="message-author">${escapeHtml(data.author || 'Owner')}</span>
                <span class="message-time">${data.time || ''}</span>
            </div>
            <div style="display:flex; align-items:center; justify-content:space-between; margin-top:8px">
                <span style="font-family:var(--font-mono); font-size:20px; font-weight:700; color:#fbbf24; letter-spacing:1px;">
                    ${escapeHtml(code)}
                </span>
                <span style="font-size:12px; font-weight:700; color:var(--success); background:rgba(16,185,129,0.15); padding:4px 8px; border-radius:4px;">
                    📋 IN CLIPBOARD (0ms)
                </span>
            </div>
        `;
        feed.appendChild(dropDiv);
        feed.scrollTop = feed.scrollHeight;
    }

    // Add to history
    codesHistory.unshift({
        code,
        author: data.author,
        channel: data.channel,
        time: new Date().toLocaleTimeString('en-GB')
    });
    renderCodesHistory();

    flashIndicator(`📋 Copied: ${code}`);
}

function addSystemMsg(text, type = 'info') {
    const feed = document.getElementById('message-feed');
    if (!feed) return;
    const placeholder = feed.querySelector('.feed-placeholder');
    if (placeholder) placeholder.remove();

    const div = document.createElement('div');
    div.className = `message-item system-msg ${type}`;
    div.style.padding = '6px 12px';
    div.style.fontSize = '12px';
    div.style.borderLeft = `3px solid ${type === 'danger' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--accent)'}`;
    div.style.margin = '4px 0';
    div.innerHTML = `<span style="color:var(--text-muted)">[${new Date().toLocaleTimeString('en-GB')}]</span> ${escapeHtml(text)}`;
    feed.appendChild(div);
    feed.scrollTop = feed.scrollHeight;
}

function renderCodesHistory() {
    const list = document.getElementById('codes-history-list');
    if (!list) return;

    if (!codesHistory || codesHistory.length === 0) {
        list.innerHTML = '<div class="history-empty">No codes copied yet</div>';
        return;
    }

    list.innerHTML = codesHistory.slice(0, 20).map(c => `
        <div class="history-item" style="display:flex; align-items:center; justify-content:space-between; padding:8px; border-bottom:1px solid var(--border);">
            <div>
                <div style="font-family:var(--font-mono); font-weight:700; font-size:13px; color:#fbbf24;">${escapeHtml(c.code)}</div>
                <div style="font-size:10px; color:var(--text-muted);">${escapeHtml(c.channel || '')} • ${c.time || ''}</div>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="copyToBrowserClipboard('${c.code}', true)" title="Re-copy">📋</button>
        </div>
    `).join('');
}

function clearFeed() {
    const feed = document.getElementById('message-feed');
    if (feed) {
        feed.innerHTML = `
            <div class="feed-placeholder">
                <span class="placeholder-icon">👀</span>
                <p>Feed cleared. Standing by for new messages...</p>
            </div>
        `;
    }
    messageCount = 0;
    const countEl = document.getElementById('feed-count');
    if (countEl) countEl.textContent = '0 msgs';
}

// ============================================
// Clipboard Helpers
// ============================================

async function copyToBrowserClipboard(text, notify = false) {
    if (!text) return;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        if (notify) flashIndicator(`📋 Re-copied: ${text}`);
    } catch (e) {}
}

async function testClipboardCopy() {
    try {
        const res = await fetch('/api/test-copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'SPY-TEST-7777-8888' })
        });
        const data = await res.json();
        if (data.success) {
            setLatestCopied(data.code);
            copyToBrowserClipboard(data.code);
            flashIndicator('✅ Copied "SPY-TEST-7777-8888" to Clipboard! Hit Ctrl+V to verify.');
        }
    } catch (e) {
        flashIndicator('❌ Test copy failed: ' + e.message);
    }
}

// ============================================
// Config Management
// ============================================

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const cfg = await res.json();

        if (cfg.token) document.getElementById('discord-token').value = cfg.token;
        if (cfg.channelId) document.getElementById('channel-id').value = cfg.channelId;
        if (cfg.codeRegex) document.getElementById('code-regex').value = cfg.codeRegex;
        if (cfg.presenceStatus) document.getElementById('presence-status').value = cfg.presenceStatus;
        if (cfg.soundAlert !== undefined) document.getElementById('sound-alert').checked = cfg.soundAlert;
        if (cfg.autoStart !== undefined) document.getElementById('auto-start').checked = cfg.autoStart;
    } catch (e) {}
}

async function saveAndStart() {
    const token = (document.getElementById('discord-token')?.value || '').trim();
    const channelId = (document.getElementById('channel-id')?.value || '').trim();
    const codeRegex = (document.getElementById('code-regex')?.value || '').trim();
    const presenceStatus = document.getElementById('presence-status')?.value || 'online';
    const soundAlert = document.getElementById('sound-alert')?.checked ?? true;
    const autoStart = document.getElementById('auto-start')?.checked ?? true;

    if (!token) {
        flashIndicator('⚠️ Please enter your Discord Account Token!');
        return;
    }
    if (!channelId) {
        flashIndicator('⚠️ Please enter at least one Channel ID!');
        return;
    }

    const payload = {
        token,
        channelId,
        codeRegex,
        presenceStatus,
        soundAlert,
        autoStart
    };

    try {
        await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        flashIndicator('💾 Settings Saved. Starting Gateway...');
        await fetch('/api/monitor/start', { method: 'POST' });
    } catch (e) {
        flashIndicator('❌ Save failed: ' + e.message);
    }
}

async function toggleMonitor() {
    if (isRunning) {
        await fetch('/api/monitor/stop', { method: 'POST' });
    } else {
        await saveAndStart();
    }
}

function toggleVis(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
}

function flashIndicator(msg) {
    const el = document.getElementById('save-indicator');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 3500);
}

function escapeHtml(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatMessageContent(content) {
    let esc = escapeHtml(content);
    // highlight triggers
    esc = esc.replace(/(@everyone|@here|ready\??|get\s*ready|drop|giveaway|giftcard)/gi, '<span style="color:#fbbf24;font-weight:700">$1</span>');
    return esc;
}
