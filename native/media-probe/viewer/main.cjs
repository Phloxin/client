// Electron main for the probe 2 viewer: one window with the built page, no app code.
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
  win.loadFile(join(__dirname, 'dist', 'index.html'))
})

app.on('window-all-closed', () => app.quit())
