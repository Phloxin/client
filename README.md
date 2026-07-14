# Pylon — Desktop Client

A Discord/TeamSpeak-style desktop client for voice, video/screen-share, and text
chat. Built with Electron + React, it connects to the Pylon backend over HTTP and
two WebSockets: one for real-time events, one for voice/video media via a
[mediasoup](https://mediasoup.org/) SFU.

The window is frameless with a custom title bar, ships ten themes, persists
logins and saved servers encrypted via the OS keychain, and can target any number
of saved servers. A native Rust module captures screen-share audio per-app or
system-wide (WASAPI process loopback on Windows, PipeWire on Linux).

---

## Tech Stack

| Layer              | Technology                                                                     |
| ------------------ | ------------------------------------------------------------------------------ |
| Desktop shell      | Electron 43 (frameless window, custom title bar)                               |
| Frontend framework | React 19                                                                       |
| Build tooling      | electron-vite + Vite 7, packaged with electron-builder                         |
| Routing            | React Router 7 (HashRouter)                                                    |
| State management   | React Context (`AuthContext`, `SettingsContext`) + local component state       |
| Animation          | [Motion](https://motion.dev) (springs, layout animation) + CSS, per-category toggles |
| Realtime events    | WebSocket (`/ws`) with heartbeat + session resume                              |
| Voice / video      | WebSocket (`/voice`) + `mediasoup-client` (WebRTC SFU, SVC video)              |
| Screen-share audio | Native Rust napi module (`native/audio-capture`): WASAPI process loopback / PipeWire |
| Noise suppression  | `@sapphi-red/web-noise-suppressor` (RNNoise WASM)                              |
| Global hotkeys     | `uiohook-napi` (passive hook) + XDG Global Shortcuts portal on Wayland         |
| Chat rendering     | `simple-markdown` + `highlight.js` + `unicode-emoji-json`                      |
| Icons              | `@tabler/icons-react`                                                          |
| Fonts              | Self-hosted `@fontsource-variable` (Inter, Open Sans, DM Sans, Roboto, Nunito) |
| Styling            | CSS (theme variables, gradients, animations)                                   |

---

## Features

**Voice**

- Join a channel to talk over a mediasoup SFU; audio from everyone in the channel mixes through a shared Web Audio graph.
- RNNoise noise suppression and a volume/noise gate applied to the local mic before publishing.
- Per-client local volume/mute overrides (right-click a user); remote volumes can be boosted past 100% via GainNodes.
- Mute / deafen with state broadcast to other clients (`VoiceStateUpdate`); moderators can server-mute ("gag") a client.
- Output-device (sinkId) and master-volume selection.
- Global mute/deafen hotkeys. They are passive on X11, Windows, and macOS; Wayland uses compositor-managed portal shortcuts.

**Video & screen share**

- Share a screen, an app window, or a webcam; the source picker shows live thumbnails with Screens / Apps / Devices tabs.
- Stream quality options: 30/60 fps, 720p/1080p/1440p, and an Optimize choice — **Detail** (sharp text, fps drops first under load) or **Motion** (smooth motion, resolution drops first). Choices persist across sessions.
- Codec strategy: AV1 with VP9 fallback for screen share (single spatial layer + temporal SVC, resolution-scaled bitrate caps); webcams prefer hardware H.264.
- Screen-share audio modes: just the shared app (native per-app capture), entire system, system-minus-Pylon, or off — backed by the native capture module with a Chromium-loopback fallback.
- Video grid of all live streams with a focused view and thumbnail carousel. Bandwidth is rationed per view: the focused stream gets full quality, grid tiles a medium layer, carousel thumbnails a low-fps layer, and hidden/unwatched streams are paused server-side.
- Each stream is opt-in ("watch"): nothing consumes bandwidth until you play it.
- Scroll-to-zoom on the focused stream with drag-to-pan and a hover minimap showing the zoomed region (click/drag the minimap to navigate). Zoom resets when focus changes.
- Only the focused stream's audio plays, with its own volume/mute.
- Pop the video grid out into its own window (reads the live `MediaStream`s off `window.opener`); the main window falls back to chat while popped out.

**Text chat**

- Per-channel message feed with markdown, syntax-highlighted code blocks, emoji (picker + shortcodes), and mentions (incl. `@everyone`).
- Emoji reactions with live counts.
- File/image/video attachments (multipart upload), an in-app image viewer, and "download to disk" via a native save dialog.
- Edit and delete your own messages; `(edited)` marker driven by the server.
- Scroll-up history pagination (fetches older pages until the channel is exhausted).
- Typing indicators (throttled outbound, auto-expiring inbound).
- Link-preview / rich embeds that arrive asynchronously via `MessageUpdated`.
- Peek any channel's chat without joining its voice (single-click), including while streaming.

**Direct messages & presence**

- 1:1 DMs are just `dm`-type channels; open via double-click or "poke" (fire a DM without leaving your view).
- Read-state / unread tracking: a sidebar dot is derived from each channel's `last_message_id` vs. an acknowledged read cursor, synced across sessions.
- Notification bell (mentions) and a DM inbox that seeds unread DMs on connect.

**Moderation, roles & channels**

- Kick, ban (timed or permanent), and unban users; banned users surface in the roster for un-banning.
- Assign/remove roles; effective permissions computed as a BigInt bitflag OR across held roles (`ADMINISTRATOR`, `KICK_MEMBERS`, `BAN_MEMBERS`, `MANAGE_CHANNELS`, `MANAGE_ROLES`, ...). Menu actions are gated on the local client's computed permissions; the server stays authoritative.
- Per-channel permission overwrites (allow/deny bitfields per role or user) edited from the Channel Details view.
- Vanity groups: cosmetic server groups (name + icon, no permissions) shown as tags/badges on user rows.
- Channel management: create/delete, drag-to-reorder, icons, descriptions; drag a user onto a channel to move them.

**Servers & sessions**

- Manage a list of saved servers (nickname / host / username / password); the list and credentials are persisted **encrypted** via the OS keychain (`safeStorage`).
- Auto-register on first connect if the account doesn't exist, then log in.
- Refresh-token auth: short-lived access tokens rotated via `/auth/refresh`; token + client identity persisted encrypted so you stay logged in across restarts.
- Resilient realtime: heartbeat, exponential backoff with jitter, and session resume that replays missed events; a full connection-lost overlay while reconnecting.

**UI / appearance**

- Frameless window with a custom Discord-style title bar (minimize/maximize/close over IPC).
- Ten themes: Studio (default), Daylight, Midnight, Aurora, Terra, Rosé Pine, Catppuccin Frappé, Catppuccin Mocha, Dracula, Gruvbox.
- Appearance settings: background transparency (Acrylic on Windows 11 / compositor blur on Linux), surface gradients, shadows, interface font, cozy/compact messages, and per-category animation toggles (respects OS reduced-motion).
- Configurable UI sound effects (join/leave, message, stream start/stop) with per-category toggles.
- `DEV_MODE` mock data path so the UI runs with no backend.

---

## Project Structure

```
pylon/
├── build/                          # Packaging resources (icons, mac entitlements)
├── resources/                      # App icon (non-Windows)
├── native/
│   └── audio-capture/              # Rust napi module: per-app/system screen-share audio
├── scripts/
│   └── postinstall.cjs             # Builds/links the native module after install
├── electron.vite.config.mjs        # electron-vite config
├── electron-builder.yml            # Win / mac / Linux packaging targets
├── src/
│   ├── main/
│   │   ├── index.js                # Electron main process (windows, IPC, persistence, capture)
│   │   ├── keybinds.js             # Global passive keyboard hook (uiohook-napi / Wayland portal)
│   │   ├── audioCapture.js         # Bridges renderer ↔ native audio-capture host
│   │   └── audioCaptureHost.js     # Child-process host for the native capture module
│   ├── preload/
│   │   └── index.js                # Context-isolated bridge (exposes window.electron)
│   └── renderer/
│       ├── index.html              # Renderer entry + Content-Security-Policy
│       └── src/
│           ├── main.jsx            # React entry — mounts providers, applies saved theme/prefs
│           ├── App.jsx             # Routes: / , /admin , /settings , /popout
│           ├── context/
│           │   ├── AuthContext.jsx     # token + client identity (synced to main process)
│           │   └── SettingsContext.jsx # mic / sound / appearance / animation / keybind settings
│           ├── hooks/
│           │   ├── useSoup.js          # Voice/video session lifecycle
│           │   └── useTheme.js
│           ├── lib/
│           │   ├── soup.js             # mediasoup client: transports, produce/consume, SVC roles, codecs
│           │   ├── screenAudio.js      # Screen-share audio capture modes (native backends)
│           │   ├── auth.js             # authFetch + refresh-token rotation
│           │   ├── serverConfig.js     # Active host → apiBase/wsBase/cdnUrl/ICE servers
│           │   ├── permissions.js      # Permission bitflags + overwrite math
│           │   ├── markdown.jsx        # Message markdown renderer
│           │   ├── emojiData.js        # Emoji dataset/lookup
│           │   ├── sounds.js           # UI sound effects + categories
│           │   ├── animation.js        # Reduced-motion + presence helpers
│           │   ├── motionPresets.js    # Shared Motion spring/fade presets
│           │   ├── themeUtils.js       # Theme catalog + apply/persist (+ legacy id migration)
│           │   ├── uiSettings.js       # Appearance/animation/font application
│           │   ├── avatarFile.js / imageColors.js / roleIcon.jsx
│           │   └── mock.js             # DEV_MODE mock channels/clients/streams
│           ├── pages/
│           │   ├── Main.jsx            # Primary view: sidebar + chat/video + all realtime wiring
│           │   ├── Settings.jsx        # In-app settings overlay
│           │   ├── Popout.jsx          # Detached video-grid window
│           │   └── Admin.jsx           # Legacy standalone admin window (/#/admin)
│           ├── components/
│           │   ├── SideBar.jsx / ServerMenu.jsx        # Channels, roster, server switcher, dock controls
│           │   ├── VoiceChannel.jsx / ClientIndicator.jsx / Channel.jsx
│           │   ├── ChatPanel.jsx / EmojiPicker.jsx / ImageViewer.jsx
│           │   ├── VideoGrid.jsx / ScreenSourcePicker.jsx   # Streams, zoom/minimap, source picker
│           │   ├── ChannelSummary.jsx / ChannelPermissions.jsx  # Channel details + overwrite editor
│           │   ├── ClientSummary.jsx / RolesGroupsMenu.jsx      # Profiles, roles & vanity groups
│           │   ├── AudioSettings.jsx / VolumeGateMeter.jsx / KeybindsSettings.jsx
│           │   ├── LoginScreen.jsx / ThemeSwitcher.jsx / SegmentedTabs.jsx
│           │   ├── TitleBar.jsx                     # Custom window controls
│           │   ├── NotificationBell.jsx / Inbox.jsx # Notifications + DM inbox
│           │   ├── ConnectionOverlay.jsx            # Reconnecting overlay
│           │   ├── Toast.jsx                        # Transient error/success banner
│           │   ├── IdleAnimation.jsx                # Disconnected/idle view (ASCII fire)
│           │   └── ErrorBoundary.jsx
│           ├── worklets/
│           │   └── pcm-source-processor.js  # AudioWorklet feeding native capture PCM into WebRTC
│           └── styles/                 # base / globals / themes / gradients / animations
```

---

## Architecture

### Electron Main Process (`src/main/index.js`)

The Node.js backbone. Responsibilities:

- **Windows** — creates a frameless main `BrowserWindow` (content-size minimums derived from the sidebar layout), plus the legacy admin window and the video popout (allowed as a same-process child window via `setWindowOpenHandler`).
- **Custom title bar controls** — `window-minimize` / `window-maximize-toggle` / `window-close` / `window-is-maximized`, resolved from the calling window so any frameless window works.
- **Encrypted persistence** — auth token + client identity (`auth.json`) and the saved server list with credentials (`servers.json`), both encrypted with `safeStorage` (OS keychain), falling back to plaintext only where encryption is unavailable. On Linux it forces the `basic` password-store so encryption is always available.
- **Screen capture** — enumerates capturable screens/windows with thumbnails for the renderer's picker, and services `getDisplayMedia` with the chosen source and audio mode.
- **Screen-share audio** — hosts the native capture module in a child process (`audioCaptureHost.js`) and streams PCM to the renderer, where an AudioWorklet turns it into a WebRTC track.
- **Window vibrancy** — applies native Acrylic material on Windows 11.
- **`get-channel-messages`** — history fetch proxy: the endpoint is `GET` but expects a JSON body (`limit`/`before`/`after`/`around`), which the Fetch spec forbids, so the request is made from the main process via `http`/`https` and handed back parsed.
- **`download-file`** — native save dialog + fetch + write for chat attachments.
- **Global keybinds** — sets up/tears down the passive OS key hook.

### Screen-Share Audio (`native/audio-capture` + `lib/screenAudio.js`)

A Rust napi module capturing audio outside Chromium's sandbox:

- **Windows** — WASAPI process loopback: capture just the shared app's audio, the whole system, or the system excluding Pylon itself.
- **Linux** — PipeWire: per-app capture of selected playback streams, or a system mix.
- Capability detection picks the best mode per platform/tab; where no native backend exists, the picker falls back to Chromium's `getDisplayMedia` loopback. Captured PCM rides an AudioWorklet (`pcm-source-processor.js`) into a `MediaStreamTrack` published as `ScreenShareAudio` (stereo Opus). Only the focused stream's share audio is audible.

### Global Keybinds (`src/main/keybinds.js`)

Uses `uiohook-napi` to observe keystrokes OS-wide **without consuming them** on X11, Windows, and macOS. Wayland does not permit passive global input observation, so there Electron registers each action through the compositor's XDG Global Shortcuts portal. Shortcut capture itself uses focused renderer keyboard events on every platform; matching global shortcuts fire `keybinds:trigger` back to the renderer (mute/deafen).

### Preload (`src/preload/index.js`)

Context-isolated bridge exposing `window.electron.ipcRenderer` (from `@electron-toolkit/preload`) so the renderer can do IPC without direct Node access.

### React Entry (`src/renderer/src/main.jsx`)

Applies the saved theme and appearance/animation prefs _before first paint_ (to avoid a flash), then mounts:

```
<ErrorBoundary>
  <HashRouter>            ← client-side routing (files load from disk, no server)
    <AuthProvider>        ← token + client identity, synced to the main process
      <SettingsProvider>  ← mic / sound / appearance / animation / keybind settings
        <App />
```

### Routing (`src/renderer/src/App.jsx`)

| Path        | Component  | Description                                        |
| ----------- | ---------- | -------------------------------------------------- |
| `/`         | `Main`     | Primary app view                                   |
| `/settings` | `Settings` | Settings (also shown as an in-app overlay in Main) |
| `/popout`   | `Popout`   | Detached video-grid window                         |
| `/admin`    | `Admin`    | Legacy standalone admin window                     |

> Moderation now happens inline in the main window (role/kick/ban menus in the roster). The `/admin` route/window is retained but secondary.

### Auth (`context/AuthContext.jsx` + `lib/auth.js`)

`AuthContext` provides `token` and `client` identity via `useAuth()`; on mount it pulls any persisted values from the main process (`get-token` / `get-client`) and writes changes back so they survive restarts and are shared across windows. `lib/auth.js` wraps fetch with `authFetch`: it attaches the bearer token and, when the access token expires, atomically rotates the refresh token via `/auth/refresh` (single-flight, so concurrent requests share one rotation). A rejected refresh signals session-expired and drops the app back to the disconnected state.

---

## Realtime: Events Socket (`/ws`)

Opened from `Main.jsx` after connecting. It uses an op-coded protocol with a
one-shot handshake, heartbeats, and session resume.

**Handshake (op 0, IDENTIFY):** sends `{ token }`, or `{ token, resume: { session_id, seq } }` when resuming. The server replies with one of:

| Reply            | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `Authenticated`  | Fresh session — server pushes a `Ready` snapshot next                       |
| `Resumed`        | Resume accepted — missed events replay in order, then live events continue  |
| `InvalidSession` | Resume refused — drop session, resync, reconnect fresh                      |
| `Unauthorized`   | Token rejected — stop retrying, return to disconnected                      |

**Heartbeat (op 2 → ack op 4):** sent every 10s carrying the last processed
sequence; an unacknowledged beat marks the connection dead and triggers a
reconnect (exponential backoff + jitter, capped at 30s).

**Voice state (op 1):** declarative — every send carries the full desired
`{ self_mute, self_deaf, channel_id }`, merged from a local ref so a mute toggle
never drops the channel and a move never resets mute.

**Dispatched events (op 3 / bare `{ ev, data }`):**

| Event                                                  | Effect                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `Ready`                                                | Authoritative snapshot: channels, clients, read states; seeds unread DMs    |
| `NewUser` / `ClientModified` / `ClientRemoved`         | Roster add / merge (channel, roles, vanity, avatar, name) / remove          |
| `VoiceStateUpdate`                                     | Another client's mute/deafen (incl. server mute/deafen)                     |
| `ClientKicked` / `ClientBanned`                        | Drop from roster (and record ban)                                           |
| `MessageCreated` / `MessageUpdated` / `MessageDeleted` | Chat feed + `last_message_id` upkeep; embeds/reactions via `MessageUpdated` |
| `ReadStateUpdated`                                     | Read cursor moved (this or another session)                                 |
| `ChannelCreated` / `ChannelUpdated` / `ChannelDeleted` | Channel list, order, icons, descriptions, permission overwrites             |
| `VanityCreated` / `VanityDeleted`                      | Cosmetic server-group catalog                                               |
| `TypingStarted`                                        | Refreshes a client's 10s typing entry                                       |

Join/leave and stream start/stop play UI chimes, baselined on connect/channel-change so reconnects don't replay as new activity.

## Realtime: Voice Socket (`/voice`)

`lib/soup.js` runs a `mediasoup-client` `Device`: it creates send/receive
transports, produces the local mic (after the RNNoise + gate chain) and any
screen/camera video, and consumes remote producers. Key mechanics:

- **Codecs** — screen share requests AV1 (VP9 fallback); webcams prefer H.264
  (usually hardware-encoded). Screen share encodes a single spatial layer with
  temporal SVC (`L1T3`) and a resolution-scaled bitrate cap, which keeps the
  full-res image sharp instead of splitting bits across layers.
- **View-role bandwidth rationing** — video consumers start server-paused; the
  grid assigns each stream a role (`focused` / `grid` / `thumbnail` / `hidden`)
  and asks the SFU for matching layers (`SetConsumerPreferredLayers`) or a full
  pause, so off-screen streams cost zero bytes.
- **Reconnect** — the voice socket **can't resume**: on drop the server tears
  down transports, so recovery is a full re-establish (re-assert channel, fresh
  ticket via `/server/voice`, reconnect, re-publish) with backoff+jitter; remote
  streams return when the server replays `NewProducer`. Screen shares are not
  auto-restored (re-capturing requires a user gesture).
- **ICE** — public STUN plus a TURN relay derived from the active server's IP
  (`turn:<host>:3478`).

---

## API Endpoints

Base URL is `http://<host>` for the currently connected server (built at call
time in `serverConfig.js`). All authenticated requests send
`Authorization: Bearer <token>`.

| Method          | Endpoint                                | Description                                                                                               |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `POST`          | `/login`                                | Authenticates a user and creates an independent device session                                             |
| `POST`          | `/register`                             | Creates a user and its first device session                                                                |
| `POST`          | `/auth/refresh`                         | Atomically rotates a refresh token and returns a replacement auth response                                 |
| `GET`           | `/server/voice`                         | Single-use ticket for the voice socket                                                                     |
| `GET`           | `/channels/:id/messages`                | Recent history — GET with JSON body (`limit`/`before`/`after`/`around`), routed through the main process   |
| `POST`          | `/channels/:id/messages`                | Send a message (multipart: `payload_json` + `files[i]`)                                                    |
| `PATCH`/`DELETE`| `/channels/:id/messages/:mid`           | Edit / delete own message                                                                                  |
| `PUT`/`DELETE`  | `/channels/:id/messages/:mid/reactions/:emoji` | Add / remove own reaction                                                                           |
| `POST`          | `/channels/:id/typing`                  | Announce typing                                                                                            |
| `PUT`           | `/channels/:id/read-state`              | Ack read cursor (`{ last_acknowledged_message_id }`)                                                       |
| `POST`          | `/channels/dm`                          | Get-or-create a DM channel (`{ recipient_ids }`)                                                           |
| `POST`          | `/server/channel`                       | Create a channel (`{ name, user_limit, position }`)                                                        |
| `PATCH`/`DELETE`| `/channels/:id`                         | Update a channel (position, description, icon) / delete it                                                 |
| `PUT`/`DELETE`  | `/channels/:id/permissions/:targetId`   | Set / remove a permission overwrite (`{ type, allow, deny }`)                                              |
| `GET`           | `/server/roles`                         | Role list (with permission bitflags)                                                                       |
| `GET`/`POST`    | `/server/vanity`                        | List / create vanity groups                                                                                |
| `PUT`/`DELETE`  | `/server/clients/:id/vanity/:vanityId`  | Assign / remove a vanity group                                                                             |
| `GET`           | `/server/bans`                          | Ban list (fetched only when the client holds `BAN_MEMBERS`)                                                |
| `PUT`/`DELETE`  | `/server/clients/:id/roles/:roleId`     | Assign / remove a role                                                                                     |
| `POST`          | `/server/clients/:id/kick`              | Kick (`{ reason? }`)                                                                                       |
| `POST`/`DELETE` | `/server/clients/:id/ban`               | Ban (`{ duration_seconds, reason? }`) / unban                                                              |
| `PATCH`         | `/client/self`                          | Update own profile (e.g. `{ avatar }`)                                                                     |
| `PATCH`         | `/client/:id`                           | Moderate a client: move to a channel (`{ channel_id }`) or server-mute (`{ mute }`)                        |
| —               | `/cdn/...`                              | Server-relative asset paths, anchored to the active host (`cdnUrl`)                                        |

---

## IPC Channels

| Channel                                                                     | Direction                | Purpose                                     |
| --------------------------------------------------------------------------- | ------------------------ | ------------------------------------------- |
| `window-minimize` / `window-maximize-toggle` / `window-close`               | Renderer → Main          | Custom title bar controls                   |
| `window-is-maximized` / `window-maximized-change`                           | invoke / Main → Renderer | Maximized state for the title bar icon      |
| `store-token` / `get-token` / `store-client` / `get-client` / `clear-auth`  | Renderer ↔ Main          | Encrypted auth persistence                  |
| `get-servers` / `store-servers`                                             | Renderer ↔ Main          | Encrypted saved-server list                 |
| `get-screen-sources` / `set-screen-source` / `set-screen-audio-mode`        | Renderer ↔ Main          | Screen-share source picker + audio mode     |
| `audiocapture:get-capabilities` / `list-apps` / `start` / `stop`            | Renderer ↔ Main          | Native screen-share audio capture           |
| `get-channel-messages`                                                      | Renderer → Main (invoke) | History fetch (GET-with-body proxy)         |
| `download-file`                                                             | Renderer → Main (invoke) | Save an attachment via native dialog        |
| `set-window-vibrancy`                                                       | Renderer → Main          | Toggle Acrylic on Windows 11                |
| `keybinds:set` / `keybinds:get-status`                                      | Renderer → Main          | Push binds / query hook availability        |
| `keybinds:trigger`                                                          | Main → Renderer          | Fire a bound action (mute/deafen)           |
| `theme-changed-ipc`                                                         | Renderer → Main → All    | Broadcast theme change across windows       |
| `open-admin`                                                                | Renderer → Main          | Open the legacy admin window                |
| `admin-log`                                                                 | Renderer → Main → All    | Broadcast a log line to all windows         |

---

## Getting Started

### Prerequisites

- Node.js 22–24 (`>=22.12 <25`)
- npm >= 10
- Rust toolchain — only if you need to rebuild the native audio-capture module
  (a prebuilt Windows binary ships in-repo; `npm run build:native` rebuilds)

### Install

```bash
npm install       # postinstall links/builds the native module
```

### Run in development

```bash
npm run dev
```

### Build

```bash
npm run build            # electron-vite build
npm run build:win        # + electron-builder (NSIS installer)
npm run build:mac        # + dmg
npm run build:linux      # + AppImage / snap / deb
```

Other scripts: `npm run lint`, `npm run format`, `npm start` (preview a build),
`npm run build:native` (rebuild the Rust audio-capture module).

---

## Notes

- **Frameless window:** the renderer draws its own title bar; window minimums are content-area sizes derived from the sidebar layout so controls never clip.
- **CSP:** `src/renderer/index.html` restricts sources but allows `http/https/ws/wss` connections (any server host), `blob:`/`data:` media, WASM eval (RNNoise), and YouTube frames for embeds.
- **DEV_MODE** (`lib/mock.js`): renders the full UI with mock channels/clients/streams and no backend. Dev builds also log outbound encoder stats (codec implementation, limitation reason, resolution/fps) every 3s during a share.
