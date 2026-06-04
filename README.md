# CNaps Buddies and Friends — Client

A desktop voice/chat client built with Electron + React, connecting to the CNaps backend over HTTP and WebSocket.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| Frontend framework | React |
| Build tooling | electron-vite + Vite |
| Routing | React Router (HashRouter) |
| State management | React Context (AuthContext) |
| Realtime | WebSocket |
| Styling | CSS (Discord-inspired dark theme) |

---

## Project Structure

```
my-app/
├── resources/
│   └── icon.png                  # App icon
├── src/
│   ├── main/
│   │   └── index.js              # Electron main process
│   ├── preload/
│   │   └── index.js              # Preload bridge (exposes IPC to renderer)
│   └── renderer/
│       └── src/
│           ├── App.jsx           # Root component — sets up React Router routes
│           ├── App.css           # Global styles
│           ├── main.jsx          # React entry point — mounts app with providers
│           ├── assets/
│           │   ├── main.css      # Base CSS (resets, html/body/root sizing)
│           │   └── base.css      # CSS variables and font definitions
│           ├── context/
│           │   └── AuthContext.jsx   # Auth token state shared across all pages/windows
│           ├── components/
│           │   ├── Channel.jsx         # Renders a single channel and its members
│           │   ├── ClientIndicator.jsx # Renders a single client name under a channel
│           │   └── LoginScreen.jsx     # Login form UI
│           └── pages/
│               ├── Main.jsx      # Primary app view (sidebar + activity log)
│               └── Admin.jsx     # Admin panel (move users between channels)
```

---

## How It Works

### Electron Main Process (`src/main/index.js`)

The main process is the Node.js backbone of the app. It is responsible for:

- Creating the main `BrowserWindow` on launch
- Storing the auth token in memory so it persists across windows (`authToken` variable)
- Handling IPC messages from the renderer:
  - `ping` — test IPC connection
  - `store-token` — saves the auth token from any window into main process memory
  - `get-token` — returns the stored token to any window that asks (used on window open)
  - `admin-log` — forwards a log message to all open windows
  - `open-admin` — opens the Admin Panel in a second `BrowserWindow` pointed at `/#/admin`

### Preload (`src/preload/index.js`)

Acts as a secure bridge between the Electron main process and the React renderer. Exposes `window.electron.ipcRenderer` so the renderer can send and receive IPC messages without direct access to Node.js APIs.

### React Entry Point (`src/renderer/src/main.jsx`)

Wraps the entire app in three providers before mounting:

```
<HashRouter>           ← handles client-side routing in Electron
  <AuthProvider>       ← provides token state to all components
    <App />
  </AuthProvider>
</HashRouter>
```

`HashRouter` is used instead of `BrowserRouter` because Electron loads files directly from disk — there is no server to handle clean URL paths.

### Routing (`src/renderer/src/App.jsx`)

Two routes are defined:

| Path | Component | Description |
|---|---|---|
| `/` | `Main` | Primary app view |
| `/admin` | `Admin` | Admin panel (opened in second window) |

### Auth Context (`src/renderer/src/context/AuthContext.jsx`)

Provides a `token` and `setToken` to any component via the `useAuth()` hook.

On mount it calls `ipcRenderer.invoke('get-token')` to retrieve any token already stored in the main process — this ensures the token persists when the Admin window is closed and reopened.

When `setToken` is called it also sends `store-token` to the main process so the token is available to future windows.

---

## Pages

### Main (`src/renderer/src/pages/Main.jsx`)

The primary view of the app. On load:

1. If no token is present, renders the `LoginScreen` component
2. Once logged in, fetches channels and clients from the API (with auth header)
3. Opens a WebSocket connection to receive real-time events
4. Listens for IPC `log-message` events from the main process

**WebSocket events handled:**

| Event | Action |
|---|---|
| `NewUser` | Adds client to state, logs to activity log |
| `ClientModified` | Updates client's `channel_id` in state, logs move |

The sidebar uses the live `clients` state (not the stale fetch data) so it always reflects real-time channel membership.

### Admin (`src/renderer/src/pages/Admin.jsx`)

Opened as a separate Electron window via the Admin Panel button. Allows:

- Logging in (if not already authenticated)
- Selecting a client and a channel and sending a `PATCH /server/client` request to move them
- Displaying token status

All requests include the `Authorization: Bearer <token>` header. The token is shared with the main window via the main process.

---

## API Endpoints

| Method | Endpoint | Auth Required | Description |
|---|---|---|---|
| `POST` | `/login` | No | Returns `{ token }` on success |
| `GET` | `/server/channel` | Yes | Returns array of channels with client id arrays |
| `GET` | `/server/client` | Yes | Returns array of all clients with `channel_id` |
| `PATCH` | `/server/client` | Yes | Moves a client to a channel — body: `{ client_id, channel_id }` |

All authenticated requests send `Authorization: Bearer <token>` in the request header.

The Vite dev server proxies `/api/*` requests to `http://47.16.222.82:3000` to avoid CORS issues during development.

---

## WebSocket

Connects to `ws://47.16.222.82:3000/ws` after login. Receives JSON events in the format:

```json
{ "ev": "EventName", "data": { ... } }
```

The connection is opened in `Main.jsx`'s `useEffect` and closed on component unmount.

---

## IPC Communication

Electron IPC is used to communicate between the main process and renderer windows, and between windows themselves.

| Channel | Direction | Purpose |
|---|---|---|
| `ping` | Renderer → Main | Test IPC |
| `open-admin` | Renderer → Main | Open admin window |
| `store-token` | Renderer → Main | Save auth token in main process |
| `get-token` | Renderer → Main (invoke) | Retrieve stored auth token |
| `admin-log` | Renderer → Main → All Windows | Broadcast log message to all windows |
| `log-message` | Main → Renderer | Display a message in the activity log |

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run in development

```bash
npm run dev
```

### Build

```bash
npm run build
```

---

## Environment

The app connects to a backend server at `47.16.222.82:3000`. In development, Vite proxies `/api/*` to that address. The WebSocket connects directly to `ws://47.16.222.82:3000/ws`.

The Content Security Policy in `src/renderer/index.html` is configured to allow connections to this origin.
