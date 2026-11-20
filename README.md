# Cursor Companion (v3.1.0)

**A lightweight, zero-focus AI desktop HUD for Windows — built for students, developers, and fast workflows.**

No cluttered browser tabs, no heavy chat sidebars, and no ₹1,500/month subscriptions. Press a hotkey over any problem, equation, code snippet, or spreadsheet formula and get a verified answer right beside your cursor in ~1.5 seconds.

🌐 **Official Website & Quick Start:** [burhanuddinkhandwala786.github.io/cursor-companion](https://burhanuddinkhandwala786.github.io/cursor-companion/)  
⬇️ **Download Latest Windows Installer:** [Cursor Companion v3.1.0 (.exe)](https://github.com/burhanuddinkhandwala786/cursor-companion/releases/latest)

---

## Key Features

- **Zero-Focus 2-Corner Snip (`F9` / `Alt + Q`):** Tap once at top-left and once at bottom-right. No clickable overlay window and zero window focus theft.
- **Verification-First Accuracy:** Enforces step-by-step internal verification for `NOT` / `EXCEPT` traps and compound choices (`Both B and C`, `All of the above`) before showing the final answer pill.
- **Customizable Global Shortcuts:** Right-click the System Tray icon → **Customize Shortcuts...** to rebind or disable any hotkey that clashes with VS Code, IDEs, or games.
- **Native Capture Protection:** Uses Windows native content protection (`WDA_EXCLUDEFROMCAPTURE`) with zero background PowerShell clutter.
- **Self-Healing 5-Provider Cloud Failover:** Shared pool routes automatically across Groq, Google Gemini, Cloudflare Workers AI, NVIDIA NIM, and OpenRouter—auto-discovering live models if a provider ever retires one.
- **Modular Mode Packs:** Switch from the tray between **Exam & Academic Solver**, **Coding & DSA Interview Pack**, and **Excel & Finance Formula Pack**, or add your own custom JSON packs in `%APPDATA%\cursor-companion\mode-packs.json`.
- **Hardware-Encrypted Local Keys:** Personal API keys entered in `Alt + K` are encrypted at rest via Windows DPAPI (`electron.safeStorage`) and connect directly from your PC to the AI provider.

---

## Default Hotkeys (All Customizable in Tray)

| Hotkey | Action |
| :--- | :--- |
| **`F8`** *(or `Alt + A`)* | Smart Screen Scan around cursor (auto-widens if cropped) |
| **`F9`** *(or `Alt + Q`)* | Zero-Focus 2-Corner Snip (tap top-left, then bottom-right) |
| **`Alt + C`** | Solve Highlighted Text |
| **`Alt + W` / `Alt + E`** | Rewrite / Explain Highlighted Text |
| **`Alt + X`** *(or `Esc`)* | Vanish Overlay Only (does not cancel active scan) |
| **`Alt + H`** | Re-show Latest Answer / Cycle History |
| **`F10`** | Force Cancel & Reset Pending Scan |
| **`Alt + D`** | Toggle Study Sidecar (last 15 answers) |
| **`Alt + G` / `Alt + F`** | Open Spotlight Ask Bar / Follow-up on Last Answer |
| **`Alt + P`** | Pin / Unpin HUD Pill |
| **`Alt + Enter`** | Ghost Paste Active Answer |
| **`Alt + K`** | Add Personal Free API Key (Unlimited) or `share:<KEY>` for Pro Pool |

---

## 100% Free Forever — How Quotas Work

1. **Instant Trial (Zero Setup):** Every install includes **10 free shared-pool scans/day** right out of the box (cached hits are unlimited).
2. **Unlimited Private Speed (`Alt + K`):** Grab a ₹0 free API key from [Groq](https://console.groq.com/keys) (1,000 req/day) or [Google AI Studio](https://aistudio.google.com/apikey) (no credit card required), press **`Alt + K`**, and paste it (you can even paste two comma-separated keys like `gsk_..., AIza...` for personal failover). Your PC then talks straight to the AI provider with unlimited speed.
3. **Community Pro Pool (`share:<KEY>`):** Prefer multi-cloud pooled failover? Type `share:YOUR_FREE_KEY` in **`Alt + K`** to contribute one free key to the encrypted community pool and unlock **150/day Pro Pool** priority for your device.

---

## Installation & Windows SmartScreen Note

1. Download **`Cursor Companion Setup 3.1.0.exe`** from [Releases](https://github.com/burhanuddinkhandwala786/cursor-companion/releases/latest).
2. Because this is an independent, open-source student project without a paid $400/yr code-signing certificate, Windows SmartScreen may show *"Windows protected your PC"*. Click **More info → Run anyway** (you can inspect the full client source code in the `v3` branch and verify the VirusTotal scan link on the Release page).
3. Cursor Companion runs quietly in your bottom-right **Windows System Tray**.

---

## Feedback & Voluntary Support

- **Report a bug or request a feature:** [Open a GitHub Issue](https://github.com/burhanuddinkhandwala786/cursor-companion/issues/new)
- **Support hosting upkeep (100% optional):** Visit the [official website](https://burhanuddinkhandwala786.github.io/cursor-companion/#community) for the UPI QR.

Built by [Burhanuddin Khandwala](https://github.com/burhanuddinkhandwala786).
