#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const electronBuilderCli = path.join(
  path.dirname(require.resolve('electron-builder/package.json')),
  'out',
  'cli',
  'cli.js'
)
const electronPackagePath = require.resolve('electron/package.json')
const electronDir = path.dirname(electronPackagePath)

function getElectronExecutablePath() {
  switch (process.platform) {
    case 'darwin':
      return path.join('Electron.app', 'Contents', 'MacOS', 'Electron')
    case 'win32':
      return 'electron.exe'
    default:
      return 'electron'
  }
}

function hasCompleteElectronInstall() {
  const executablePath = getElectronExecutablePath()
  const markerFile = path.join(electronDir, 'path.txt')
  const bundledExecutable = path.join(electronDir, 'dist', executablePath)

  if (!fs.existsSync(markerFile) || !fs.existsSync(bundledExecutable)) {
    return false
  }

  return fs.readFileSync(markerFile, 'utf8').trim() === executablePath
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    ...options
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}`)
  }
}

function installAppDeps() {
  run(
    process.execPath,
    [electronBuilderCli, 'install-app-deps'],
    'electron-builder install-app-deps'
  )
}

// Build the Rust N-API screenshare-audio addon (native/audio-capture). N-API is
// ABI-stable, so unlike uiohook-napi it does not need an Electron-specific
// rebuild - one cargo build serves both dev (system Node) and Electron.
function buildNativeAddon() {
  const cargoCheck = spawnSync('cargo', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32'
  })
  if (cargoCheck.error || cargoCheck.status !== 0) {
    console.warn(
      '[postinstall] cargo not found - skipping native/audio-capture build. ' +
        'Screenshare audio capture will be unavailable; install Rust (https://rustup.rs) and re-run npm install.'
    )
    return
  }

  try {
    // npm is npm.cmd on Windows; batch files must be spawned through a shell
    // (Node >= 18.20 rejects them with EINVAL otherwise).
    run('npm', ['--prefix', 'native/audio-capture', 'run', 'build'], 'audio-capture native build', {
      shell: process.platform === 'win32'
    })
  } catch (error) {
    console.warn(
      `[postinstall] native/audio-capture build failed: ${error.message}. ` +
        'Screenshare audio filtering will be unavailable until "npm run build:native" succeeds ' +
        '(needs the Rust toolchain; on Windows also the MSVC build tools).'
    )
  }
}

function installElectronBinary() {
  console.warn('[postinstall] Electron binary is not installed yet; downloading it now.')

  run('npm', ['exec', '--', 'install-electron', '--no'], 'Electron binary install', {
    shell: process.platform === 'win32'
  })

  if (!hasCompleteElectronInstall()) {
    throw new Error(
      'Electron is still missing its bundled executable. Run "npm exec -- install-electron --no" and retry.'
    )
  }
}

try {
  installAppDeps()
  buildNativeAddon()

  if (!hasCompleteElectronInstall()) {
    installElectronBinary()
  }
} catch (error) {
  console.error(`[postinstall] ${error.message}`)
  process.exit(1)
}
