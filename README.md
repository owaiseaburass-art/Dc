# SpyHub Key Sniper & 24/7 Discord AFK Spoofer

A browser-based real-time key sniper and Discord multi-account AFK online spoofer designed for SpyHub drops.

![Preview](preview.png)

## 🚀 Features

- **⚡ Real-Time Discord Gateway Sniping**: Direct WebSocket connection (`wss://gateway.discord.gg`) to detect `SPY-XXXX-XXXX-XXXX` format codes instantaneously.
- **🎯 Prefire Mode**: Split-screen view featuring the live Discord channel feed on the left and a pre-loaded redemption console on the right with quick actions (`Paste`, `Clear`, `Old Key`).
- **🛡️ Anti-Trap / Honeypot Filter**: Context-aware scanning that identifies trap keywords (e.g., `ban lifetime`, `lifetime ban`, `dont redeem`, `blacklist`) and auto-blocks bait keys before redemption.
- **🧪 Test Connection & History Extraction**: Built-in verification testing for tokens and automatic extraction of past safe giveaway keys for dry-runs.
- **🟢 24/7 Discord AFK Online Spoofer**: Keep multiple secondary / alt Discord accounts permanently **Online** 24/7 via headless gateway heartbeats and custom statuses.
- **🔊 Audio & Visual Alerts**: Synthesized Web Audio cues for successful snipes and visual highlights for detected keys.

---

## 📁 Project Structure

```text
spyhub-sniper/
├── index.html    # Core dashboard UI & modal controls
├── style.css     # Dark-mode styling, animations & split layout
├── sniper.js     # Discord Gateway engine, parser, anti-trap filter & AFK manager
├── .gitignore    # Git ignore rules
└── README.md     # Documentation
```

---

## 🛠️ How to Run

No build step or Node.js runtime required.

### Option 1: Open Directly
Simply double-click [`index.html`](index.html) or open it in any modern browser (Chrome, Brave, Edge).

### Option 2: Local Web Server
```powershell
python -m http.server 8899
```
Then navigate to `http://localhost:8899`.

---

## 📖 Setup Guide

1. **Discord Token**: Paste your Discord account authorization token.
2. **Channel ID**: Paste the numeric ID of the giveaway / drop channel you want to monitor.
3. **Guild ID** (Optional): The ID of the Discord server.
4. **SpyHub Auth**: Click **Authorize with Discord** to establish your session on SpyHub.
5. Hit **⚡ Start Sniper** or **🎯 Prefire Mode**.

---

## ⚙️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl + Shift + P` | Toggle Prefire split-screen |
| `Ctrl + Enter` | Instant Redeem code from input box |
| `Escape` | Stop sniper and return to setup panel |

---

## ⚠️ Disclaimer

This project is created strictly for educational and testing purposes. Ensure you comply with Discord's Terms of Service and applicable platform guidelines.
