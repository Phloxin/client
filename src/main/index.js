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

// Opt-in hardware video accel experiment (VOIP_HW_ACCEL=1): offloads VP9/AV1
// decode - and encode where the driver supports it - to VA-API/GPU instead of
// libvpx/libaom software paths, the dominant CPU cost while screensharing.
// Gated because it is driver-dependent (black frames / silent SW fallback on
// bad stacks). Verify with chrome://gpu and getStats() encoderImplementation/
// decoderImplementation. Escalations for stubborn drivers (add to the list
// manually when testing): VaapiIgnoreDriverChecks, VaapiOnNvidiaGPUs.
if (process.platform === 'linux' && process.env.VOIP_HW_ACCEL) {
  enableFeatures.push(
    'VaapiVideoDecoder',
    'AcceleratedVideoDecodeLinuxGL',
    'AcceleratedVideoEncoder'
  )
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

// Windows hardware video ENCODE. H.264 hardware encode works out of the box via
// the default MediaFoundation path — MFVEA creates its own D3D11 device, so it
// runs even when the GPU process is software-composited (verified on a machine
// showing 'NVIDIA H.264 Encoder MFT' alongside gpu_compositing:
// disabled_software). AV1 comes up as software libaom there; soup.js detects
// that at runtime (getStats encoderImplementation) and drops the share to H.264,
// so every machine lands on its best working encoder without GPU-model sniffing.
//
// 'D3D12VideoEncodeAccelerator' (D3D12 VEA + its AV1 delegate; feature name
// verified against this electron.exe) is OPT-IN only: on that same machine it
// produced an encoder that reported hardware AV1 but streamed black frames —
// with software compositing there are no valid shared images to import, and a
// black-but-"hardware" encoder is invisible to the runtime software fallback.
// D3D12VideoEncodeAcceleratorL1T3 (also verified in the binary): hardware
// encoders must explicitly support temporal-layer modes or WebRTC falls back
// to software — screen share requests AV1 'L1T3', so without this the D3D12
// encoder handles plain H.264 but AV1 lands on libaom even on AV1-encode GPUs.
if (process.platform === 'win32' && process.env.VOIP_HW_ACCEL) {
  enableFeatures.push('D3D12VideoEncodeAccelerator', 'D3D12VideoEncodeAcceleratorL1T3')
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

// Smallest the window may get before the sidebar starts being clipped. These
// are content-area sizes (see `useContentSize` below), derived from the
// renderer layout so the sidebar at its narrowest stays fully usable.
//   .layout padding  = --spacing-sm (8px) on every edge
//   sidebar MIN_WIDTH = 180px (SideBar.jsx, border-box so borders included)
const LAYOUT_PADDING = 8
const SIDEBAR_MIN_WIDTH = 180

// Width: both side paddings + the sidebar is the clip floor (196), but we hold
// the window to a wider 385px minimum so the chat area stays usable too.
const MIN_CONTENT_WIDTH = Math.max(385, SIDEBAR_MIN_WIDTH + LAYOUT_PADDING * 2)

// Height: top+bottom padding + the sidebar's fixed-height chrome - the server
// header, the "Channels" label, and the bottom control-button wrapper - so the
// control buttons stay visible even at the shortest allowed height. (The
// channel list between them is the part that gives when space is tight.)
const SIDEBAR_HEADER_HEIGHT = 49
const SIDEBAR_SECTION_LABEL_HEIGHT = 42
const SIDEBAR_CONTROLS_HEIGHT = 93
// The custom title bar sits inside the content area now that the window is
// frameless, so its height counts against the usable layout space. Keep in
// sync with --title-bar-height in TitleBar.css.
const TITLE_BAR_HEIGHT = 32
const MIN_CONTENT_HEIGHT =
  LAYOUT_PADDING * 2 +
  TITLE_BAR_HEIGHT +
  SIDEBAR_HEADER_HEIGHT +
  SIDEBAR_SECTION_LABEL_HEIGHT +
  SIDEBAR_CONTROLS_HEIGHT // 232

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    // Treat width/height/min* as the web content area (excludes the OS title
    // bar) so the minimums map directly onto the renderer layout below.
    useContentSize: true,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    show: false,
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

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

  // Remember which source the user picked for the upcoming share.
  ipcMain.on('set-screen-source', (_, sourceId) => {
    selectedScreenSourceId = sourceId
  })

  // Remember the audio mode for the upcoming share (see soup.js shareScreen).
  ipcMain.on('set-screen-audio-mode', (_, mode) => {
    selectedAudioMode = typeof mode === 'string' ? mode : 'none'
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
