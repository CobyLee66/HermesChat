**English** · [简体中文](README.zh-CN.md)

# HermesChat

**A remote client for Hermes Agent** — one codebase for Android, Windows, macOS, and the browser.

Connect to the [Hermes Agent](#1-set-up-hermes-agent) running on your computer from your phone or desktop, and work with your agent the way you'd chat with a person: multiple profiles, multiple sessions, streaming replies, reasoning traces, tool calls, approval and clarification prompts, image/file/voice attachments, and scheduled-task management.

- **One codebase, four targets** — React Native (Android) + react-native-web (browser) + Electron (Windows / macOS). The UI and protocol layers are fully shared; only native capabilities (SSH, audio recording, file picking) fork per platform.
- **Built-in SSH tunnel** — a native SSH module detects or launches `hermes serve` on the remote host, opens a local port forward, and reconnects with exponential backoff, resuming in-flight turns via `session.resume`. No manual tunneling, and no need to expose the service to the internet.
- **Zero server-side changes** — uses only Hermes' public protocols (WS JSON-RPC + REST). It never modifies the server's source, configuration, or data.

---

## Features

| Area | What you get |
|---|---|
| Connections | Multiple connection profiles (SSH tunnel / direct), card-based management, one-tap connect, optional auto-connect on launch |
| Profiles | Avatar + nickname + model badge + status dot; edit nickname and avatar in-app (`profiles.configure` / `profiles.set_asset`) |
| Sessions | Create / resume / rename / delete / restart; isolated per profile; search, category filter (Chats / Automation / All), two sort modes (recent activity / creation time) |
| Chat | Streaming text, collapsible reasoning traces, tool-call cards (arguments + result + diff highlighting), errors, Markdown rendering including horizontally scrollable tables |
| Interactions | Inline permission-approval buttons (once / session / always / deny), clarification cards (single choice / multi-select / batched), interrupt long-running turns |
| Models | Bottom-sheet model picker (`model.options` + `config.set`); the header shows model · context usage · reasoning effort in real time |
| Attachments | Multi-select photos (auto-compressed), arbitrary files (`@file:` references), voice recording → server-side STT transcription |
| Search | "Find in chat" with jump + highlight; session list search by title and preview |
| Scheduled tasks | Task list (status badge / human-readable schedule / next run / error details), pause & resume, run now, run history, read-only run replay, six-mode schedule builder (interval / daily / weekly / monthly / one-off / custom cron) |
| Desktop extras | Responsive three-column layout (narrow / medium / wide breakpoints), native file dialogs, paste & drag-and-drop attachments, completion notifications while unfocused |

---

## Architecture

```
┌──────────── Client (this repo) ─────────┐                    ┌──── Your machine ────┐
│  UI (RN / RNW / Electron)               │   SSH (22)         │  hermes serve        │
│    ↓                                    │  ═══════════════>  │  127.0.0.1:9119      │
│  Store (zustand) ──> RpcClient (JSON-RPC)│  built-in tunnel   │  /api/ws             │
│    ↓                    ↑               │  127.0.0.1:L       │  /api/**             │
│  SshManager ──> native SSH / ssh2        │  auto-reconnect    │                      │
└─────────────────────────────────────────┘  + session resume  └──────────────────────┘
```

- **`src/ssh/`** — every platform difference is confined here: the `HermesSsh` contract plus per-platform implementations (Kotlin/JSch on Android, ssh2 in the Electron main process, direct HTTP/WS in the browser). The `SshManager` state machine (`disconnected → connecting → bootstrapping → tunneling → ready → reconnecting`) is shared by all three.
- **`src/rpc/`** — JSON-RPC request/response pairing, per-session event dispatch, the message aggregator (event stream → `TimelineItem[]`), and REST wrappers (cron, run history).
- **`src/panels/`** — panels **shared** between the phone screens and the desktop columns (session list, timeline, composer, overlays, flow helpers). This is what keeps behaviour identical across platforms.
- **`desktop/`** — the Electron main process: window, ssh2 tunnel, and a loopback proxy. The renderer is served from `127.0.0.1:<port>`, so it is same-origin with the gateway and sidesteps both CORS and the gateway's WS Host/Origin checks.

---

## Requirements

**Client**

- Node.js ≥ 22.11
- Browser: any modern Chromium / Firefox
- Android: JDK 21 + Android SDK (compileSdk 37 / targetSdk 36, build-tools 37.0.0, NDK 27.1.12297006)
- iOS: not enabled yet (the project scaffolding is kept; the native SSH module still needs to be written)
- Desktop: no extra toolchain (Electron is installed via npm; building the Windows package is best done on Windows)

**Server**

- Hermes Agent installed and running on your computer, with `hermes serve` / `hermes dashboard` listening on `127.0.0.1:9119` (the default)

---

## Getting Started

### 1. Set up Hermes Agent

Start the Hermes service on your computer (it listens on `127.0.0.1:9119` by default):

```bash
hermes serve        # or: hermes dashboard
```

The app talks to the FastAPI service behind `serve` / `dashboard` (WS `/api/ws` + REST `/api/**`) — **not** to `hermes gateway`, which is the messaging-platform gateway.

### 2. Try it in the browser first (fastest)

```bash
npm install
npm run web         # vite dev server, http://localhost:5188 by default
```

Open the page and click **"⚡ Browser direct (local 127.0.0.1:9119)"** on the connection screen. Vite proxies `/api/**` to port 9119 and rewrites Host/Origin; the session token is extracted from the SPA HTML automatically.

> Browser mode can only reach a gateway on **the same machine** (the proxy targets `127.0.0.1:9119`), and native-dependent features (attachments, voice, SSH tunneling) are stubbed out. It exists for development and UI preview.

### 3. Android

```bash
npm run android     # requires the full RN toolchain (JDK 21 + Android SDK + NDK)
```

Or just build and install an APK:

```bash
cd android && ./gradlew assembleRelease        # output: android/app/build/outputs/apk/release/
adb install -r app/build/outputs/apk/release/app-release.apk
```

There are also convenience scripts under `scripts/` (`build-android.sh`, `install-android.sh`, `device-log.sh`), plus `build-android-remote.sh` / `build-desktop-remote.sh` for the case where your machine has no Android toolchain and you build on a second machine over SSH. Those drive a remote `git pull` and build; the host and paths are configurable through environment variables (see the header comments in each script).

### 4. Desktop (Windows / macOS)

```bash
npm run desktop:dev     # dev mode: build the web bundle + compile the main process + launch Electron
```

Packaging:

```bash
npm run dist:mac        # macOS dmg (arm64)
npm run dist:win        # Windows NSIS installer + win-unpacked portable build
```

Artifacts land in `dist-desktop/`. The packages are unsigned: on Windows choose "Run anyway" at the SmartScreen prompt, on macOS right-click → Open.

---

## Connection Setup

On the connection screen, tap **"+ Add profile"**. There are two connection types:

### SSH tunnel (recommended, best for phones)

| Field | Notes |
|---|---|
| Host / port | The machine running Hermes, e.g. `192.168.1.10` / `22` |
| Username | Your SSH login user |
| Auth | Password, or paste a private key in PEM format (passphrase supported) |

The app then handles everything: it checks whether `hermes serve` is already running remotely → starts it if not → opens a local port forward → connects the WebSocket. On disconnect it reconnects with exponential backoff (1s → 30s) and resumes your sessions.

**This is the only way to reach a remote service safely from your phone** — the service keeps listening on the remote loopback interface only and is never exposed to the internet.

### Direct connection (best for desktop / LAN debugging)

Connects straight to an already-running gateway (`host` + `port`). If you leave the session token empty it is extracted from the gateway's index page (`__HERMES_SESSION_TOKEN__`); you can also fill it in manually.

- Desktop: the renderer is cross-origin to the gateway, so token extraction and request forwarding happen in the Electron main process (loopback proxy).
- Browser: only `127.0.0.1:9119` on the same machine.
- Phone: the gateway must listen on a non-loopback address (or run `adb reverse tcp:9119 tcp:9119` first).

---

## Usage

1. **Connect** — tap a profile card on the home screen. To auto-connect on launch, tap the "auto-connect" dot on a card (it is global: pick one, tap again to clear).
2. **Pick a profile** — the profile list shows every agent; tap one to see its sessions. Tap the avatar or nickname to edit it.
3. **Sessions** — "New session" in the top right starts a conversation; pull to refresh; two dropdowns on the toolbar control **filtering** (Chats / Automation / All) and **sorting** (recent activity / creation time); the search pill filters by title and preview; long-press or right-click a row to rename, delete, or find in chat.
4. **Chat** — type in the composer at the bottom. While a reply streams you can scroll up to read history (streaming content will not drag the viewport; scroll back to the bottom or send a message to resume following). The header shows "model · context usage · reasoning effort"; the ⋯ menu in the top right lets you switch models, rename or delete the session, find in chat, and hide tool and reasoning blocks.
5. **Responding to prompts** — when the agent asks for permission or needs clarification, an inline card appears; just tap a button. There is no need to type commands.
6. **Attachments** — the "＋" button offers photos (compressed before upload), files (inserted as `@file:` references), and voice (recorded, then transcribed server-side via STT). On desktop you can also paste images and drag files onto the window.
7. **Copying Markdown** — on desktop/web, select text in an assistant reply and press `Cmd/Ctrl+C` to get the **Markdown source** rather than rendered text. The bubble's context menu also offers "Copy Markdown" / "Copy plain text".
8. **Scheduled tasks** — switch to "Scheduled" from the top left of the home screen: browse tasks, pause/resume, run now, edit, and view run history. Tapping a run opens a read-only replay (metadata + transcript), with an option to open it in chat.

**Desktop shortcuts**: `Enter` to send / `Shift+Enter` for a newline, `Ctrl+N` for a new session, `Esc` to close overlays.

---

## Development

### Common commands

```bash
npx tsc --noEmit            # type check
npm run lint                # eslint
npm test                    # jest unit tests
npm run web                 # browser dev server (hot reload)
npm run web:build           # build the web bundle into dist-web/
npm run desktop:build       # compile the Electron main process
node scripts/harness.mjs    # end-to-end against local 127.0.0.1:9119 (sends one real prompt)
```

### Project layout

```
src/
  screens/      Mobile navigation screens (connection / profiles / sessions / chat / cron)
  panels/       Panels shared by phone and desktop (session list, timeline, composer, overlays, flows)
  desktop/      Electron renderer shell (responsive three-column)
  components/   UI components (bubbles, avatar, Markdown, tool card, reasoning block, approval/clarify cards…)
  rpc/          JSON-RPC client, event aggregator, REST wrappers, types
  ssh/          Native capability contract, per-platform implementations, tunnel state machine
  store/        zustand stores (connection / chat / sessions / profiles / cron)
  utils/        Pure helpers (scroll follow, search, sorting, validation, Markdown source mapping…)
  web-stubs/    Browser stubs for native modules
desktop/        Electron main process + preload + packaging config
scripts/        Build, install, and smoke-test scripts
__tests__/      jest specs
docs/           Design, protocol, and native-module contracts
```

### Smoke tests

`scripts/` contains Playwright-based end-to-end smoke tests (`web-*-smoke.js` / `desktop-*-smoke.js`). Together with `scripts/mock-gateway.js` — a local fake gateway covering streaming replies, sessions, the cron REST API, and more — they exercise UI behaviour **without touching a real service**:

```bash
node scripts/web-scroll-follow-smoke.js    # starts the mock, builds, previews — fully automated
```

### Conventions

- UI strings and code comments are written in Chinese.
- zustand selectors must return stable references (no inline objects such as `?? []`).
- Platform differences stay inside `src/ssh/`; the UI and protocol layers remain platform-agnostic.

---

## Language Support

- **Documentation**: this README is available in **English** and [**简体中文**](README.zh-CN.md). The design documents under `docs/` are currently Chinese-only.
- **App UI**: English and Simplified Chinese are supported. The interface **follows your system language automatically** (unsupported languages fall back to English), and a small in-app toggle (System / 中文 / EN) lets you override it. Adding a new language only requires one dictionary file — see `docs/i18n.md` (Chinese) for the framework contract.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/plan.md`](docs/plan.md) | Overall design (goals, scope, architecture, milestones) |
| [`docs/protocol.md`](docs/protocol.md) | WS JSON-RPC + REST protocol details and measured findings |
| [`docs/ssh-module.md`](docs/ssh-module.md) | Native SSH module contract |
| [`docs/desktop.md`](docs/desktop.md) | Unified desktop and web approach |
| [`DECISIONS.md`](DECISIONS.md) | Architecture and technology decisions |
| [`PROGRESS.md`](PROGRESS.md) | Development progress and pitfalls |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution guide (branching, DCO, sensitive-data discipline) |
| [`SECURITY.md`](SECURITY.md) | Security policy and private vulnerability reporting |

*(Design documents are written in Chinese.)*

---

## License

This project is licensed under the **[GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later)** — an OSI-approved free software license.

Copyright (c) 2026 CobyLee66

**You are free to** use, modify, and distribute this software, **including commercially** — no fees, and no need to ask the author for permission.

**Provided that**: if you **distribute** the software or a derivative work, or **make it available to others as a network service** (AGPL section 13), you must release the **complete corresponding source code** under the same AGPL license.

In one sentence: **use it yourself, modify it freely, use it commercially — but you may not ship a closed-source derivative or run one as a closed service.**

### Why AGPL rather than GPL

This project also runs as a browser and desktop app, so it could be turned into a network service offered to others. GPL only governs *distribution* and says nothing about software that merely runs on a server without being distributed; AGPL section 13 closes that gap, ensuring that modified versions offered as a service contribute their source back.

### What you can do

| Scenario | Allowed? |
|---|---|
| Install and use it yourself (including at work) | ✅ Yes |
| Modify it for internal use without distributing | ✅ Yes |
| Integrate it into a commercial product and distribute | ✅ Yes, **but you must open-source your derivative under AGPL** |
| Turn it into a website/service for others | ✅ Yes, **but you must provide the complete source to users** |
| Sell it as a closed-source product | ❌ No |
| Operate it as a closed-source cloud service | ❌ No |

The full terms are in [`LICENSE`](LICENSE) — the verbatim FSF text, unmodified.

### Third-party components

All dependencies use permissive licenses (44 × MIT, 2 × Apache-2.0), which are compatible with AGPL. UI icons come from [Tabler Icons](https://github.com/tabler/tabler-icons) (MIT).

### Contributing

Because this project is AGPL, contributions are released under the same license. Please add a `Signed-off-by:` line to your commits ([DCO](https://developercertificate.org/)), certifying that you have the right to submit the code and agree to license it under AGPL. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for details.

### Security

Please do not report security issues in public. Use the private vulnerability reporting channel — see [`SECURITY.md`](SECURITY.md).

### Disclaimer

HermesChat is an **unofficial** third-party client. It is not affiliated with or endorsed by the Hermes Agent project or its authors. All "Hermes" names and marks belong to their respective owners. The software is provided "as is", without warranty of any kind; evaluate the risks yourself before use, particularly around SSH credentials and access to remote hosts.
