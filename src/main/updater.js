import { app, ipcMain, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// Manual flow driven by the General settings tab: user clicks Check → Download →
// Restart & Install. Nothing downloads on its own. A downloaded update still
// installs on quit (electron-updater default), so "keep working, install on
// close" needs no extra wiring.
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

function broadcast(type, payload = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:event', { type, ...payload })
  }
}

// A launch check is silent: only 'available' surfaces (as a popup). The
// checking/not-available/error chatter is suppressed so it never disturbs the
// settings UI or the user when nothing's new. The flag rides the single
// in-flight check between checkForUpdates() and its terminal event.
let launchCheckActive = false

export function setupUpdater() {
  autoUpdater.on('checking-for-update', () => {
    if (!launchCheckActive) broadcast('checking')
  })
  autoUpdater.on('update-available', (info) => {
    const launch = launchCheckActive
    launchCheckActive = false
    broadcast('available', { version: info.version, launch })
  })
  autoUpdater.on('update-not-available', () => {
    if (launchCheckActive) launchCheckActive = false
    else broadcast('not-available')
  })
  autoUpdater.on('download-progress', (p) => broadcast('progress', { percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) => broadcast('downloaded', { version: info.version }))
  autoUpdater.on('error', (err) => {
    if (launchCheckActive) launchCheckActive = false
    else broadcast('error', { message: String(err?.message || err) })
  })

  ipcMain.handle('updater:check', async () => {
    // Dev builds have no app-update.yml; checkForUpdates would reject. Tell the
    // UI it's an installed-only feature instead of surfacing a confusing error.
    if (!app.isPackaged) return broadcast('disabled')
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      broadcast('error', { message: String(err?.message || err) })
    }
  })

  // Silent check fired once on launch. No-op in dev (no app-update.yml).
  ipcMain.handle('updater:check-on-launch', async () => {
    if (!app.isPackaged) return
    launchCheckActive = true
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      launchCheckActive = false
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      broadcast('error', { message: String(err?.message || err) })
    }
  })

  // Quit and install now. Downloaded-but-not-installed updates otherwise apply
  // on the next app close via autoInstallOnAppQuit.
  // isSilent: skip the NSIS wizard (assisted installer would otherwise show it
  // and re-ask for the install dir). isForceRunAfter: silent installs don't
  // relaunch on their own.
  ipcMain.on('updater:install', () => autoUpdater.quitAndInstall(true, true))

  ipcMain.handle('get-app-version', () => app.getVersion())
}
