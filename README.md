<div align="center">

<img src="resources/icon.png" alt="Voksa logo" width="120" />

# Voksa

**The browser built for going live.**

Stream, record or share your screen without ever leaking an email, an IP
address, a phone number or a private URL. Voksa masks them on screen before
a single frame can escape, keeps the wrong tab from being heard, and panics
faster than you can.

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

 
<div align="center">
<table>
<tr>
<td align="center" width="33%">
<h3>🛡️</h3>
<b>The zero-leak mask</b>
<br/>
<sub>Nothing sensitive is ever painted.<br/>Not for one frame, on any page.</sub>
</td>
<td align="center" width="33%">
<h3>🎙️</h3>
<b>The streamer arsenal</b>
<br/>
<sub>Panic key, safe screen-share,<br/>pre-live audit, per-tab audio.</sub>
</td>
<td align="center" width="33%">
<h3>🌐</h3>
<b>A real daily driver</b>
<br/>
<sub>Google sign-in, Chrome extensions,<br/>memory saver, dark mode.</sub>
</td>
</tr>
</table>
</div>

 
## Why Voksa?

Every streamer and remote worker knows the fear: you share your screen, open one wrong tab, and your email, your client's name or your home IP is on the recording.

> **A VOD keeps every frame. Anyone can pause on the exact one where your data was visible. One leaked frame is leaked forever.**

Blurring after the fact is too late. Voksa is a full desktop browser built around one guarantee: **when Stream Mode is on, nothing sensitive is ever painted**. Not for a frame, not during a reload, not inside an iframe. And around that guarantee, a complete toolkit for going live.

 
## 🛡️ Stream Mode

<div align="center">
<i>One shortcut (<code>Ctrl+Shift+S</code>), one click on the shield, or nothing at all:<br/>
Voksa detects OBS, Streamlabs, XSplit and vMix, and arms itself before you even share.</i>
</div>
<br/>

<table>
<tr>
<th width="50%">🎭 What gets masked, live</th>
<th width="50%">🔐 What makes the guarantee hold</th>
</tr>
<tr>
<td valign="top">
<br/>
🔢 <b>IP addresses (v4 and v6), emails, phone numbers</b>, as pages load and change
<br/><br/>
🏷️ <b>Your own keywords</b>: a client name, a project codename, a username. While you are live, even the settings page shows the list as redacted chips
<br/><br/>
🖥️ <b>Your machine's hostname</b> on internal tools <sub>(opt-in)</sub>
<br/><br/>
⌨️ <b>Form fields</b>, visually redacted as you type; what you submit stays intact
<br/><br/>
🧭 <b>The browser itself</b>: tab titles, address bar, suggestions, internal pages, history surfaces
<br/><br/>
</td>
<td valign="top">
<br/>
🎬 Pages are revealed <b>only after masking has run</b>: first load, reload, back/forward, tab switch, SPA route change, iframes
<br/><br/>
🕳️ What <b>cannot</b> be masked is <b>hidden, never shown raw</b>: a frame Chromium refuses to inject into, a PDF (painted by a plugin, unreachable by any masker)
<br/><br/>
🚫 <b>WebRTC blocked</b> (the classic IP leak); camera, microphone and location auto-denied; the hover bubble disappears (the hovered URL never leaves the main process); speculative connections cut (they would leak hostnames in TLS handshakes)
<br/><br/>
🕶️ Address-bar suggestions and new-tab top sites <b>stop drawing from your history</b> while live
<br/><br/>
</td>
</tr>
</table>

 
## 🎙️ The streamer arsenal

<table>
<tr>
<td width="50%" valign="top">
<h3>🚨 Panic button</h3>
One <b>system-wide</b> shortcut, working even while OBS or your game has the focus: every Voksa window is instantly curtained, all sound is cut. Press again to come back. The protection deliberately <b>stays armed</b> after restore: whatever caused the panic must not reappear.
</td>
<td width="50%" valign="top">
<h3>🖥️ Screen-share handshake</h3>
When Meet, Zoom or Discord (web) asks to share your screen, Voksa shows <b>its own picker</b>. Picking a surface that contains Voksa arms Stream Mode and waits for masking confirmation <b>before the first frame is delivered</b>. Even the thumbnails of Voksa surfaces are withheld: a thumbnail is a screenshot taken before masking.
</td>
</tr>
<tr>
<td valign="top">
<h3>✅ Go-Live preflight</h3>
One click before the stream lists exactly what a viewer could catch: an email in a tab title, a sensitive URL, a background tab making sound. Each finding has a <b>one-click fix</b>, and every preview is already masked: the audit names the risk without reprinting it. It audits Voksa, honestly, not Discord or the rest of your desktop.
</td>
<td valign="top">
<h3>🎧 Per-tab audio</h3>
While live, a background tab that starts playing is <b>muted automatically</b>; a chip on the tab allows it back, explicitly. And any tab's sound can be <b>routed to another output</b>: right-click, pick your headset, and OBS, which captures the default output, no longer hears that tab. You still do. <b>No virtual cable, no second browser.</b>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
<h3>🔔 Sound signals</h3>
Short audio cues confirm Stream Mode arming and disarming: you <b>hear</b> the mask go up without looking away from OBS. Cues for finished downloads and ready updates are opt-in.
</td>
</tr>
</table>

 
## 🎯 Why not just a masking extension?

An extension runs **inside a page the browser has already drawn**. It reacts after the fact, so on every load, reload, new tab, iframe or fast page change there is a window of a few frames where the raw content is painted first. Your VOD records every one of them.

Voksa works the other way around: because it IS the browser, pages are kept invisible from the very first byte and only revealed **after** masking has run. There is no window, on any navigation path, by construction.

| | Masking extensions | Voksa |
|---|:---:|:---:|
| When masking happens | After the page is drawn | **Before the page is ever shown** |
| Frame-by-frame VOD scrubbing | Recovers transition frames | **Nothing to recover** |
| Browser UI (tabs, address bar, suggestions) | Untouchable by extensions | **Masked too** |
| Store pages, internal pages, PDF viewer | Extensions are blocked there | **Covered** |
| Starts with your recorder | No idea OBS exists | **Auto-arms with OBS, Streamlabs, XSplit, vMix** |
| The screen-share picker | Chromium's, raw thumbnails | **Voksa's own, masked before delivery** |
| Background tab starts blasting music | Nothing | **Auto-muted while live** |
| Keep a tab's audio away from OBS | Virtual cable + second browser | **Right-click the tab** |
| Panic while the game has focus | Extensions live inside the browser | **System-wide shortcut** |
| Camera, mic, location prompts on stream | Still pop up | **Auto-denied** |

 
## 🌐 Your everyday browser

 
<div align="center">
<i>The protection would be worthless in a browser you open only to stream.<br/>
Voksa is built to be the one you keep.</i>
</div>

 
### 🔑 Sign in and extend

- **Google, Gmail and YouTube** sign-in works in-app, like in any browser.
- Extensions install straight from the **Chrome Web Store**: uBlock Origin, Bitwarden and friends just work, with toolbar icons, badges, popups, cascading right-click menus and drag-to-reorder.

### 🧠 Tabs that respect your machine

- **Memory Saver**: inactive tabs genuinely give their memory back to the OS, then come back where you left them, scroll position and half-filled forms included. Three levels, an always-alive site list, a manual "put to sleep" action.
- **Pinned tabs**, **multiple windows**, full **session restore** (quitting restores everything, like Chrome), reopen closed tab (`Ctrl+Shift+T`), per-tab mute and audio indicators.

### 🔎 Search your way

- Seven engines built in (Google, Bing, DuckDuckGo, Brave, Qwant, Ecosia, Startpage) plus **your own**, with `%s` standing for the query.
- Every engine gets a **keyword**: type `duckduckgo.com`, hit Space, and search it without changing your default.
- **On startup**: the New Tab page, your previous session, or pages you choose.
- Links feel faster: DNS, TCP and TLS are warmed for hovered links (never while streaming: the warm-up itself would leak hostnames).

### 🧰 Everything a daily driver needs

- **Downloads** with progress, pause and cancel; **find in page**; per-site **zoom** that sticks; **print** with live preview and PDF export; picture-in-picture; HTML5 fullscreen.
- A built-in **PDF viewer**, **HTTP Basic Auth** dialogs (router admin pages, intranets), a proper **TLS interstitial** with "proceed anyway" (per host and certificate, memory-only).
- **Bookmarks** with nested folders and drag and drop; searchable **history**; fine-grained **clear browsing data** (what × since when).
- Full **dark mode**, **French and English**, Chrome-style settings with search, **automatic background updates**.

### 🚚 Switching is a single click

- **Import from Chrome or Firefox**: bookmarks and history. **Never passwords**: decrypting another browser's vault is not something a healthy program does.
- Voksa registers as a **default browser** with Windows, macOS and Linux.

 
## 🔒 Private by architecture

> **No account. No cloud. No telemetry.**
> Your history, bookmarks and settings live in local files on your machine, and nowhere else.

- The only servers Voksa talks to on its own are your search engine's suggestion endpoint as you type, and GitHub Releases to check for updates.
- **Site permissions are yours**: every camera, microphone or location request prompts, decisions are remembered per site and editable from the address bar.
- Built on free software, and it says so: `voksa://credits` lists all 75 open source projects shipped inside a Voksa build, with their licenses.

 
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

Voksa is open source (GPL-3.0) and contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); every pull request runs the full suite on Windows, macOS and Linux, including end-to-end scenarios that actively try to leak data through the masking. A regression on the core guarantee cannot merge quietly.

 
## 📄 License

[GPL-3.0](LICENSE)

 
---

<div align="center">

**If Voksa saved your stream once, it already paid for itself.**

*It is free and open source anyway.* ⭐ *A star helps other streamers find it.*

</div>
