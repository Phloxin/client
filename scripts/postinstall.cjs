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

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`${label} exited with code ${result.status}`)
  }
}

function installAppDeps() {
  run(process.execPath, [electronBuilderCli, 'install-app-deps'], 'electron-builder install-app-deps')
}

function repairElectronInstall() {
  console.warn(
    `[postinstall] Electron was left in a partial install state under Node ${process.versions.node}. Retrying the Electron binary install with Node 22.`
  )

  if (process.platform === 'win32') {
    run(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', 'npx -y node@22 node_modules\\electron\\install.js'],
      'electron install retry'
    )
  } else {
    run('npx', ['-y', 'node@22', path.join('node_modules', 'electron', 'install.js')], 'electron install retry')
  }

  if (!hasCompleteElectronInstall()) {
    throw new Error(
      'Electron is still missing its bundled executable. Delete node_modules and package-lock.json, switch to Node 22 LTS, then run npm install again.'
    )
  }
}

try {
  installAppDeps()

  if (!hasCompleteElectronInstall()) {
    repairElectronInstall()
  }
} catch (error) {
  console.error(`[postinstall] ${error.message}`)
  process.exit(1)
}