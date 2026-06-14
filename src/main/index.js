import { app, shell, BrowserWindow, ipcMain, session, desktopCapturer, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
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

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 670,
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