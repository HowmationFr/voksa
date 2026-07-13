<div align="center">

<img src="resources/icon.png" alt="Voksa logo" width="120" />

# Voksa

**The browser built for streaming.**

Share your screen or go live without ever leaking an IP address, an email,
a phone number or a private URL. Voksa masks them on screen, in real time,
before a single frame can escape.

<br/>

[![Download](https://img.shields.io/github/v/release/HowmationFr/voksa?style=for-the-badge&label=%E2%AC%87%EF%B8%8F%20%20DOWNLOAD&color=2ea043&labelColor=1a7f37)](https://github.com/HowmationFr/voksa/releases/latest)

*Windows · macOS · Linux*

<br/>

[![Latest release](https://img.shields.io/github/v/release/HowmationFr/voksa?label=latest&color=blue)](https://github.com/HowmationFr/voksa/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/HowmationFr/voksa/ci.yml?branch=main&label=tests)](https://github.com/HowmationFr/voksa/actions/workflows/ci.yml)
[![Downloads](https://img.shields.io/github/downloads/HowmationFr/voksa/total?color=purple)](https://github.com/HowmationFr/voksa/releases)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-orange)](LICENSE)

</div>

---

## Why Voksa?

Every streamer and remote worker knows the fear: you share your screen, open one wrong tab, and your email, your client's name or your home IP is on the recording forever. Blurring after the fact is too late.

Voksa is a full desktop browser with one superpower: **Stream Mode**. Flip it on and everything sensitive is masked on screen the instant it would appear, with a zero-leaked-frame guarantee. You browse normally; viewers see nothing they should not.

## 🛡️ Stream Mode

One shortcut (`Ctrl+Shift+S`) or one click on the shield, and:

- **IP addresses, emails and phone numbers** are masked on every page, live, as pages load and change.
- **Your own keywords** (a client name, a project codename, a username) are masked everywhere too: you choose the list.
- **Form fields are visually redacted** while you type; what you submit stays intact.
- **The browser itself is masked**: tab titles, address bar, suggestions, history surfaces. Not just the page.
- **It turns itself on**: launch OBS, Streamlabs, XSplit or vMix and Voksa activates Stream Mode automatically before you even share.
- **Hardware stays private**: camera, microphone, location and screen-capture requests are silently denied, and WebRTC (the classic IP leak) is blocked.
- **No flashes.** Pages are revealed only after masking has run, on every navigation, reload and tab switch.

## 🎯 Why not just a masking extension?

Chrome extensions that blur or hide sensitive content do exist. The problem: an extension runs **inside a page the browser has already drawn**. It reacts after the fact, so on every page load, reload, new tab, iframe or fast page change there is a window of a few frames where the raw content is painted before the extension catches up.

A few frames sounds like nothing. But your stream VOD records **every single one of them**. Anyone can download the video afterwards, scrub frame by frame, and stop exactly on the one where your email or your IP was visible. One leaked frame is leaked forever.

Voksa works the other way around: because it IS the browser, pages are kept invisible from the very first byte and only revealed **after** masking has run. There is no window, on any navigation path, by construction.

| | Masking extensions | Voksa |
|---|---|---|
| When masking happens | After the page is drawn (reactive) | Before the page is ever shown |
| Frame-by-frame VOD scrubbing | Can recover data from transition frames | Nothing to recover |
| Browser UI (tabs, address bar, suggestions) | Untouchable by extensions | Masked too |
| Store pages, internal pages, PDF viewer | Extensions are blocked there | Covered |
| Starts with your recorder | No idea OBS exists | Detects OBS/Streamlabs/XSplit/vMix and switches on by itself |
| Camera / mic / location prompts on stream | Still pop up | Auto-denied |

## 🌐 Your everyday browser

- Sign in to **Google, Gmail and YouTube** normally.
- Install extensions straight from the **Chrome Web Store**: uBlock Origin, Bitwarden and friends just work, cascading right-click menus included.
- **Multiple windows**, nested **bookmark folders** with drag and drop, full **history** and search.
- **Memory Saver**: inactive tabs give their memory back to your machine and reload where you left them, scroll position and half-filled forms included. Three levels, plus a list of sites to always keep alive.
- **Search engines**: seven built in (Google, Bing, DuckDuckGo, Brave, Qwant, Ecosia, Startpage), plus your own, with `%s` standing in for the query. Every engine gets a **keyword**: type `duckduckgo.com`, hit Space, and search it without changing your default.
- **On startup**, open the New Tab page, continue where you left off, or open a set of pages you choose.
- **Downloads**, find in page, per-site **permission controls**, persistent zoom, print with live preview, session restore.
- Full **dark mode** (light, dark, or follow the system).
- **French and English**, detected from your system, switchable in Settings.
- **Automatic updates**: Voksa downloads new versions in the background and installs them on the next restart.
- Built on free software, and it says so: `voksa://credits` lists every open source project shipped inside Voksa, with its licence.

## 📥 Install

Grab the file for your platform from the [latest release](https://github.com/HowmationFr/voksa/releases/latest):

| Platform | File | Notes |
|---|---|---|
| Windows | `Voksa-Setup-x.y.z.exe` | Unsigned for now: SmartScreen may warn on first run. Click "More info", then "Run anyway". |
| macOS (Apple Silicon) | `Voksa-x.y.z-mac-arm64.dmg` | Signed and notarized by Apple. |
| macOS (Intel) | `Voksa-x.y.z-mac-x64.dmg` | Signed and notarized by Apple. |
| Linux | `Voksa-x.y.z.AppImage` | Self-updating. A `.deb` is also available (manual updates). |

Once installed, Voksa updates itself automatically in the background.

## 🤝 Contributing

Voksa is open source (GPL-3.0) and community contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); every pull request is automatically tested on Windows, macOS and Linux before it can be merged.

## 📄 License

[GPL-3.0](LICENSE)
