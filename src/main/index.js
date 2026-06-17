import { app, shell, BrowserWindow, ipcMain, session, desktopCapturer, safeStorage, dialog } from 'electron'
import { basename, join } from 'path'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import http from 'http'
import https from 'https'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

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
  if (!safeStorage.isEncryptionAvailable()) return { token: null, client: null }
  try {
    const raw = readFileSync(authFilePath(), 'utf-8')
    const data = JSON.parse(raw)
    return {
      token: data.token ? safeStorage.decryptString(Buffer.from(data.token, 'base64')) : null,
      client: data.client ? safeStorage.decryptString(Buffer.from(data.client, 'base64')) : null
    }
  } catch {
    return { token: null, client: null }
  }
}

function persistAuth() {
  if (!safeStorage.isEncryptionAvailable()) return
  try {
    const data = {}
    if (authToken != null) data.token = safeStorage.encryptString(authToken).toString('base64')
    if (authClient != null) data.client = safeStorage.encryptString(authClient).toString('base64')
    writeFileSync(authFilePath(), JSON.stringify(data))
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
  if (!safeStorage.isEncryptionAvailable()) return []
  try {
    const raw = readFileSync(serversFilePath(), 'utf-8')
    const { data } = JSON.parse(raw)
    if (!data) return []
    return JSON.parse(safeStorage.decryptString(Buffer.from(data, 'base64')))
  } catch {
    return []
  }
}

function persistServers() {
  if (!safeStorage.isEncryptionAvailable()) return
  try {
    const data = safeStorage.encryptString(JSON.stringify(servers)).toString('base64')
    writeFileSync(serversFilePath(), JSON.stringify({ data }))
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

// Width: both side paddings + the sidebar, so it never clips horizontally.
const MIN_CONTENT_WIDTH = SIDEBAR_MIN_WIDTH + LAYOUT_PADDING * 2 // 196

// Height: top+bottom padding + the sidebar's fixed-height chrome - the server
// header, the "Channels" label, and the bottom control-button wrapper - so the
// control buttons stay visible even at the shortest allowed height. (The
// channel list between them is the part that gives when space is tight.)
const SIDEBAR_HEADER_HEIGHT = 49
const SIDEBAR_SECTION_LABEL_HEIGHT = 42
const SIDEBAR_CONTROLS_HEIGHT = 93
const MIN_CONTENT_HEIGHT =
  LAYOUT_PADDING * 2 +
  SIDEBAR_HEADER_HEIGHT +
  SIDEBAR_SECTION_LABEL_HEIGHT +
  SIDEBAR_CONTROLS_HEIGHT // 200

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 670,
    // Treat width/height/min* as the web content area (excludes the OS title
    // bar) so the minimums map directly onto the renderer layout below.
    useContentSize: true,
    minWidth: MIN_CONTENT_WIDTH,
    minHeight: MIN_CONTENT_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
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
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // The source the renderer's picker selected for the next screen-share
  // request. Read by the display-media handler below when getDisplayMedia runs.
  let selectedScreenSourceId = null

  // Return the list of capturable screens/windows (with thumbnails) so the
  // renderer can show its own source picker.
  ipcMain.handle('get-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    })
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

  // Enable screen capture via getDisplayMedia in renderer. Honors the source
  // chosen via the picker, falling back to the first available source.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const chosen = sources.find((s) => s.id === selectedScreenSourceId) || sources[0]
      callback({ video: chosen, audio: 'loopback' })
    })
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

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
  ipcMain.handle('get-channel-messages', async (_, { url, token, limit }) => {
    return new Promise((resolve) => {
      let target
      try {
        target = new URL(url)
      } catch {
        resolve({ ok: false, error: 'Invalid URL' })
        return
      }
      const lib = target.protocol === 'https:' ? https : http
      const body = JSON.stringify({ limit })
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
  })

  // Login on Admin Window — forward log message to all windows
  ipcMain.on('admin-log', (_, message) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((win) => {
      win.webContents.send('log-message', message)
    })
  })

  // Open admin panel in a new window
  ipcMain.on('open-admin', () => {
    const adminWindow = new BrowserWindow({
      width: 400,
      height: 700,
      title: 'Admin Panel',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false
      }
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      adminWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/admin')
    } else {
      adminWindow.loadFile(join(__dirname, '../renderer/index.html'), {
        hash: 'admin'
      })
    }
  })

  // Settings are now rendered as an in-app overlay in the main window.
  // The previous IPC handler that opened a separate settings BrowserWindow
  // has been intentionally removed to keep settings inside the main UI.

  ipcMain.on('theme-changed-ipc', (_, themeId) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((win) => {
      win.webContents.send('theme-changed-ipc', themeId)
    })
  })

  createWindow()

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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.