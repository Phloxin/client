import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  session,
  desktopCapturer,
  safeStorage,
  dialog
} from 'electron'
import { basename, join } from 'path'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import http from 'http'
import https from 'https'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import iconPng from '../../resources/icon.png?asset'
import iconIco from '../../build/icon.ico?asset'
// Windows taskbar/window uses the .ico; other platforms keep the png.
const icon = process.platform === 'win32' ? iconIco : iconPng
import { setupGlobalKeybinds, stopGlobalKeybinds } from './keybinds'
import { setupAudioCapture, stopAudioCaptureHost } from './audioCapture'
import { setupUpdater } from './updater'

const APP_ID = 'app.pylon.client'

// Portals need a stable XDG application ID. In development there is no
// installed .desktop file for Electron to infer it from, so set the name before
// ready; packaged Linux builds use the matching desktopName metadata below.
if (process.platform === 'linux') {
  app.setDesktopName(APP_ID)
}

// On Linux, safeStorage requires a running secret service (GNOME Keyring / KWallet).
// If neither is available, isEncryptionAvailable() returns false and the server list
// silently doesn't persist. The 'basic' backend uses Chromium's built-in key store
// so encryption is always available as a fallback.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'basic')
}

// User-controllable app settings that the main process must apply at startup
// (before app 'ready'), so they can't live in renderer localStorage. Plain
// JSON, unencrypted — nothing sensitive here. Read synchronously at module load
// because disableHardwareAcceleration() and enable-features must be set pre-ready.
// getPath('userData') is available before ready. Written via the set-app-settings
// IPC below; changes take effect on the next launch.
function appSettingsFilePath() {
  return join(app.getPath('userData'), 'app-settings.json')
}

function readAppSettings() {
  try {
    return { hardwareAcceleration: true, ...JSON.parse(readFileSync(appSettingsFilePath(), 'utf-8')) }
  } catch {
    return { hardwareAcceleration: true }
  }
}

const appSettings = readAppSettings()

// Master hardware-acceleration switch (Advanced settings). Off disables all
// Chromium GPU acceleration — the standard escape hatch for broken driver stacks
// (black frames, GPU-process crashes). Must be called before app 'ready'.
if (appSettings.hardwareAcceleration === false) {
  app.disableHardwareAcceleration()
}

// Chromium feature flags are accumulated here because appendSwitch OVERWRITES
// a previously-set 'enable-features' value - every feature must go through a
// single comma-joined switch.
const enableFeatures = []

// On Wayland, window/screen enumeration and capture must go through
// xdg-desktop-portal + PipeWire; without this flag getDisplayMedia can only
// see X11/XWayland surfaces. The portal presents its own picker dialog when
// capture starts (see the display-media handler below).
const isWayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland'
if (isWayland) {
  enableFeatures.push('WebRTCPipeWireCapturer', 'GlobalShortcutsPortal')
}

if (
  process.platform === 'linux' &&
  !process.env.VOIP_NO_HW_ENCODE &&
  appSettings.hardwareAcceleration !== false
) {
  enableFeatures.push(
    'VaapiVideoDecoder',
    'AcceleratedVideoDecodeLinuxGL',
    'AcceleratedVideoEncoder'
  )
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

// Windows hardware video ENCODE — on by default. All three feature names
// verified against this electron.exe:
//   - WebRtcAV1HWEncode: the WebRTC-layer gate. Without it the peer
//     connection's encoder factory never offers hardware AV1, no matter what
//     the GPU supports — Chrome flips it via Finch field trials, which
//     Electron never receives, so its compiled-off default applies. This (not
//     missing GPU support) was why AV1 encoded as libaom on an RTX 40-series.
//   - D3D12VideoEncodeAccelerator + D3D12VideoEncodeAcceleratorL1T3: the D3D12
//     encode path the AV1 delegate lives on, and its temporal-layer support.
// Verified end-to-end on an RTX 4070 SUPER: AV1 at 1080p via
// D3D12VideoEncodeAccelerator at ~8ms/frame. GPUs without AV1 encode still
// come up libaom and are caught by the runtime probe in soup.js
// (startEncoderStatsLog → maybeDowngradeScreenCodec), which switches the share
// to H.264 — hardware via MediaFoundation, which needs no flags at all — and
// persists that choice. Kill switches for bad driver stacks: VOIP_NO_HW_ENCODE=1
// or the Advanced settings hardware-acceleration toggle.
if (
  process.platform === 'win32' &&
  !process.env.VOIP_NO_HW_ENCODE &&
  appSettings.hardwareAcceleration !== false
) {
  enableFeatures.push(
    'D3D12VideoEncodeAccelerator',
    'D3D12VideoEncodeAcceleratorL1T3',
    'WebRtcAV1HWEncode'
  )
}

// Windows capture note: modern Chromium may already default to Windows
// Graphics Capture (WGC) for window shares. Before adding any WGC feature
// flags here, verify the exact feature names against a Windows Electron
// binary (`strings electron.exe | findstr /i wgc`) and test occluded-window
// capture - names cannot be verified from a Linux checkout and must not be
// guessed.

if (enableFeatures.length > 0) {
  app.commandLine.appendSwitch('enable-features', enableFeatures.join(','))
}

// PREFER_SCREENSHARE_CODEC=H264|AV1|VP9 pins the codec screen shares are
// produced with (consumed in the renderer via preload's preferScreenshareCodec
// — see pickVideoCodec in renderer/src/lib/soup.js). Only warn here; the value
// is normalized and applied in the renderer.
{
  const preferCodec = process.env.PREFER_SCREENSHARE_CODEC?.trim().toUpperCase()
  if (preferCodec && !['H264', 'AV1', 'VP9'].includes(preferCodec)) {
    console.warn(
      `[main] Ignoring invalid PREFER_SCREENSHARE_CODEC="${process.env.PREFER_SCREENSHARE_CODEC}" ` +
        '(expected H264, AV1, or VP9)'
    )
  }
}

// Store auth token in main process so it persists across windows
let authToken = null
let authClient = null

// ─── Encrypted auth persistence ───────────────────────────────────
// Persists the token/client to disk (encrypted via the OS keychain) so the
// user stays logged in across app restarts. Falls back to in-memory-only
// storage if encryption isn't available on this platform.
function authFilePath() {
  return join(app.getPath('userData'), 'auth.json')
}

function readAuthFile() {
  try {
    const raw = readFileSync(authFilePath(), 'utf-8')
    const data = JSON.parse(raw)
    if (safeStorage.isEncryptionAvailable() && (data.token || data.client)) {
      return {
        token: data.token ? safeStorage.decryptString(Buffer.from(data.token, 'base64')) : null,
        client: data.client ? safeStorage.decryptString(Buffer.from(data.client, 'base64')) : null
      }
    }
    return {
      token: data.plainToken ?? null,
      client: data.plainClient ?? null
    }
  } catch {
    return { token: null, client: null }
  }
}

function persistAuth() {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const data = {}
      if (authToken != null) data.token = safeStorage.encryptString(authToken).toString('base64')
      if (authClient != null) data.client = safeStorage.encryptString(authClient).toString('base64')
      writeFileSync(authFilePath(), JSON.stringify(data))
    } else {
      const data = { plainToken: authToken, plainClient: authClient }
      writeFileSync(authFilePath(), JSON.stringify(data))
    }
  } catch (err) {
    console.error('Failed to persist auth data:', err)
  }
}

// ─── Saved servers persistence ────────────────────────────────────
// The user's saved server list (nickname / host / username / password) lives in
// memory and is persisted to disk encrypted via the OS keychain, since it holds
// credentials. Falls back to in-memory-only when encryption isn't available.
let servers = []

function serversFilePath() {
  return join(app.getPath('userData'), 'servers.json')
}

function readServersFile() {
  try {
    const raw = readFileSync(serversFilePath(), 'utf-8')
    const { data, plain } = JSON.parse(raw)
    if (data && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(data, 'base64')))
    }
    if (plain) return JSON.parse(plain)
  } catch {}
  return []
}

function persistServers() {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const data = safeStorage.encryptString(JSON.stringify(servers)).toString('base64')
      writeFileSync(serversFilePath(), JSON.stringify({ data }))
    } else {
      writeFileSync(serversFilePath(), JSON.stringify({ plain: JSON.stringify(servers) }))
    }
  } catch (err) {
    console.error('Failed to persist servers:', err)
  }
}

// Smallest the window may get, as content-area sizes (see `useContentSize`
// below). This is a usability floor, not a clipping one: nothing actually breaks
// until roughly 385x232 (the sidebar's 180px minimum plus the layout padding and
// its fixed-height chrome), but the chat area and video grid are unusable long
// before that, so the window stops well above it.
const MIN_CONTENT_WIDTH = 800
const MIN_CONTENT_HEIGHT = 500

function createWindow() {
  // A hidden BrowserWindow normally gets revealed after Chromium's first paint.
  // With GPU acceleration disabled on Linux (notably native Wayland), that first
  // hidden paint may never arrive, so `ready-to-show` never fires and the app
  // keeps running without mapping a window. Show this specific software-rendered
  // case immediately; backgroundColor prevents a white flash while React loads.
  const showImmediately = process.platform === 'linux' && appSettings.hardwareAcceleration === false

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    // Treat width/height/min* as the web content area (excludes the OS title
    // bar) so the minimums map directly onto the renderer layout below.
    useContentSize: true,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    show: showImmediately,
    backgroundColor: '#1e1e1e',
    // Frameless: the renderer draws its own Discord-style title bar (see
    // TitleBar.jsx). Window controls are driven via the window-* IPC below.
    frame: false,
    // Windows + Linux read the taskbar/window icon from here in dev; macOS uses the dock.
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Live calls run 25Hz timer loops (volume gate, speaking detection) that
      // Chromium would throttle to ~1Hz while the window is hidden/minimized.
      backgroundThrottling: false
    }
  })

  if (!showImmediately) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show()
    })
  }

  // Let the custom title bar swap its maximize/restore icon when the window's
  // maximized state changes by any means (button, double-click, OS snap).
  const sendMaxState = () =>
    mainWindow.webContents.send('window-maximized-change', mainWindow.isMaximized())
  mainWindow.on('maximize', sendMaxState)
  mainWindow.on('unmaximize', sendMaxState)

  // On a frameless window Windows raises its native system menu when the drag
  // region is right-clicked, but it renders detached/unresponsive ("frozen").
  // We already expose min/max/close in the title bar, so just suppress it. The
  // event fires on the BrowserWindow (per Electron's docs); bind webContents too
  // to cover both dispatch paths.
  const suppressSystemMenu = (e) => e.preventDefault()
  mainWindow.on('system-context-menu', suppressSystemMenu)
  mainWindow.webContents.on('system-context-menu', suppressSystemMenu)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // The video-grid popout is opened with window.open(url, 'video-popout', ...)
    // so it stays same-origin/same-process as its opener and can read the live
    // MediaStream objects off window.opener. Allow it as a real child window;
    // everything else is treated as an external link.
    if (details.frameName === 'video-popout') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960,
          height: 600,
          minWidth: 360,
          minHeight: 240,
          title: 'Video Streams',
          autoHideMenuBar: true,
          backgroundColor: '#1e1e1e',
          webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            // Same as the main window: keep call timers at full rate while
            // the popout is hidden behind other windows.
            backgroundThrottling: false
          }
        }
      }
    }
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId(APP_ID)

  // Auto-update wiring (GitHub Releases). IPC + events for the General tab.
  setupUpdater()

  // Answers "is video encode/decode accelerated in THIS build" from any bug
  // report — the answer drifts across Electron upgrades. Logged on
  // gpu-info-update, NOT at ready: the GPU process only launches with the first
  // window, so a ready-time snapshot reads all-software even on healthy
  // machines. Deduped; the last line printed is the settled truth.
  let lastGpuStatus = ''
  app.on('gpu-info-update', () => {
    const status = JSON.stringify(app.getGPUFeatureStatus())
    if (status === lastGpuStatus) return
    lastGpuStatus = status
    console.log('[GPU] feature status:', status)
  })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // The source the renderer's picker selected for the next screen-share
  // request. Read by the display-media handler below when getDisplayMedia runs.
  let selectedScreenSourceId = null
  // Where the next share's audio comes from. Only 'system-legacy' uses
  // Chromium's whole-system loopback; every other mode gets audio from the
  // native audio-capture pipeline (or none), so the display stream is video-only.
  let selectedAudioMode = 'none'
  // Sources from the picker's last enumeration, so the display-media handler
  // doesn't have to re-enumerate every window just to find the chosen one.
  let cachedScreenSources = []

  // Return the list of capturable screens/windows (with thumbnails) so the
  // renderer can show its own source picker.
  ipcMain.handle('get-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    })
    cachedScreenSources = sources
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      isScreen: source.id.startsWith('screen:'),
      thumbnail: source.thumbnail.toDataURL(),
      appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
    }))
  })

  // Atomically prepare the source + audio mode and acknowledge it before the
  // renderer calls getDisplayMedia. Two fire-and-forget IPC messages could race
  // the display-media request and reuse a previous share's source/audio mode.
  ipcMain.handle('prepare-screen-share', (_, options = {}) => {
    selectedScreenSourceId = typeof options.sourceId === 'string' ? options.sourceId : null
    selectedAudioMode = typeof options.audioMode === 'string' ? options.audioMode : 'none'
    return true
  })

  // Enable screen capture via getDisplayMedia in renderer. Honors the source
  // chosen via the picker; on Wayland the enumeration below opens the OS
  // portal dialog, which does the picking itself.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const audio = selectedAudioMode === 'system-legacy' ? 'loopback' : false

    const cached = cachedScreenSources.find((s) => s.id === selectedScreenSourceId)
    if (cached && !isWayland) {
      callback({ video: cached, audio })
      return
    }
    desktopCapturer
      .getSources({ types: ['screen', 'window'] })
      .then((sources) => {
        const chosen = sources.find((s) => s.id === selectedScreenSourceId) || sources[0]
        callback({ video: chosen, audio })
      })
      .catch((err) => {
        console.error('[Main] display-media source enumeration failed:', err)
        callback({})
      })
  })

  // ─── Window transparency / vibrancy ───────────────────────────────
  // On Windows 11+ applies native Acrylic blur-behind material.
  // On Linux the CSS backdrop-filter handles the blur; nothing extra needed.
  ipcMain.on('set-window-vibrancy', (e, enabled) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (process.platform === 'win32') {
      try {
        win.setBackgroundMaterial(enabled ? 'acrylic' : 'none')
      } catch {
        // setBackgroundMaterial not available on older Windows builds
      }
    }
  })

  // ─── Custom title bar window controls ─────────────────────────────
  // Resolved from the calling window's sender, so the same handlers work for
  // any frameless window that renders the custom title bar.
  ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('window-maximize-toggle', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  ipcMain.handle(
    'window-is-maximized',
    (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  )

  // Load any previously persisted auth from disk
  const persisted = readAuthFile()
  authToken = persisted.token
  authClient = persisted.client

  // Load the saved server list from disk
  servers = readServersFile()

  // ─── Advanced app settings (startup-applied, so main-process owned) ──
  // Read the current values (e.g. hardware-acceleration toggle) for the
  // Advanced settings UI, and persist changes. Changes apply on next launch.
  ipcMain.handle('get-app-settings', () => readAppSettings())
  ipcMain.on('set-app-settings', (_, changes) => {
    try {
      const merged = { ...readAppSettings(), ...changes }
      writeFileSync(appSettingsFilePath(), JSON.stringify(merged))
    } catch (err) {
      console.error('Failed to persist app settings:', err)
    }
  })
  // Restart the app so a startup-only setting (hardware acceleration) takes hold.
  ipcMain.on('relaunch-app', () => {
    app.relaunch()
    app.exit(0)
  })

  // Return the saved server list to any window that asks
  ipcMain.handle('get-servers', () => servers)

  // Replace the saved server list (add/remove happen in the renderer)
  ipcMain.on('store-servers', (_, list) => {
    servers = Array.isArray(list) ? list : []
    persistServers()
  })

  // Store token from any window
  ipcMain.on('store-token', (_, token) => {
    authToken = token
    persistAuth()
  })

  // Return stored token to any window that asks
  ipcMain.handle('get-token', () => {
    return authToken
  })

  ipcMain.on('store-client', (_, client) => {
    authClient = client
    persistAuth()
  })

  ipcMain.handle('get-client', () => {
    return authClient
  })

  // Clear persisted + in-memory auth (e.g. on logout or token invalidation)
  ipcMain.on('clear-auth', () => {
    authToken = null
    authClient = null
    try {
      unlinkSync(authFilePath())
    } catch {}
  })

  // Download a remote file (e.g. a chat image attachment) to a user-chosen
  // location. Shows a native save dialog, then fetches the URL and writes it.
  ipcMain.handle('download-file', async (event, { url, filename }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: filename || basename(new URL(url).pathname) || 'download'
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      writeFileSync(filePath, buffer)
      return { ok: true, filePath }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  // Fetch a channel's recent messages. The endpoint is GET but expects a JSON
  // body ({ limit }), which the renderer's fetch can't send (the Fetch spec
  // forbids a body on GET). Node's http.request has no such restriction, so we
  // make the request here and hand the parsed messages back to the renderer.
  ipcMain.handle(
    'get-channel-messages',
    async (_, { url, token, limit, before, after, around }) => {
      return new Promise((resolve) => {
        let target
        try {
          target = new URL(url)
        } catch {
          resolve({ ok: false, error: 'Invalid URL' })
          return
        }
        const lib = target.protocol === 'https:' ? https : http
        const body = JSON.stringify({
          limit,
          ...(before != null ? { before } : {}),
          ...(after != null ? { after } : {}),
          ...(around != null ? { around } : {})
        })
        const req = lib.request(
          {
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              Authorization: `Bearer ${token}`
            }
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk
            })
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                  resolve({ ok: true, messages: JSON.parse(data) })
                } catch {
                  resolve({ ok: false, error: 'Invalid response JSON' })
                }
              } else {
                resolve({ ok: false, status: res.statusCode, error: data })
              }
            })
          }
        )
        req.on('error', (err) => resolve({ ok: false, error: err.message }))
        req.write(body)
        req.end()
      })
    }
  )

  ipcMain.on('theme-changed-ipc', (_, themeId) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((win) => {
      win.webContents.send('theme-changed-ipc', themeId)
    })
  })

  createWindow()

  // OS-wide mute/deafen keybinds: passive hook on X11/Windows/macOS and the
  // compositor-managed GlobalShortcuts portal on Wayland (see keybinds.js).
  setupGlobalKeybinds()

  // Native per-app screenshare audio capture (audiocapture:* IPC).
  setupAudioCapture()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Tear down the global keyboard hook so the native listener thread doesn't
// linger past quit.
app.on('will-quit', stopGlobalKeybinds)

// Stop native capture threads and their utility process with the app.
app.on('will-quit', stopAudioCaptureHost)

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
