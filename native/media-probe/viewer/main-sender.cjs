// Electron main for probe 3's Chromium baseline (D26): one window with the sender page.
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    show: true,
    webPreferences: { backgroundThrottling: false }
  })
  win.loadFile(join(__dirname, 'dist-sender', 'sender.html'))
})

app.on('window-all-closed', () => app.quit())
