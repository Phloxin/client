import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, join, resolve } from 'path'
import { inspect } from 'util'

// Production diagnostics deliberately capture warnings and errors, not the
// normal console.log/debug stream. In particular, the recurring Soup health
// and media-stat messages stay in the development console and never reach disk.
const LOG_FILENAME = 'pylon.log'
const MAX_LOG_BYTES = 2 * 1024 * 1024
const ROTATED_LOG_COUNT = 3
const MAX_RENDERER_MESSAGE_LENGTH = 32 * 1024
const MAX_LOG_MESSAGE_LENGTH = 64 * 1024
const MAX_IDENTICAL_ENTRIES = 3
const MAX_DEDUPE_SIGNATURES = 1000

const originalConsoleWarn = console.warn.bind(console)
const originalConsoleError = console.error.bind(console)
const occurrenceCounts = new Map()

let logDirectory = null
let loggingInstalled = false
let diagnosticsIpcRegistered = false

export function productionDiagnosticsEnabled() {
  return app.isPackaged
}

function currentLogPath() {
  return join(logDirectory, LOG_FILENAME)
}

function rotatedLogPath(index) {
  return join(logDirectory, `pylon.${index}.log`)
}

function redactString(value) {
  return String(value)
    .slice(0, MAX_LOG_MESSAGE_LENGTH)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_?token|token|password|secret)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(["'](?:access_?token|token|password|secret)["']\s*:\s*["'])[^"']+/gi, '$1[redacted]')
    .replace(/:\/\/([^/:\s]+):([^@/\s]+)@/g, '://$1:[redacted]@')
}

function serializableValue(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular Error]'
    seen.add(value)
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      ...(value.cause ? { cause: serializableValue(value.cause, seen) } : {})
    }
  }
  if (typeof value === 'string') return redactString(value)
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => serializableValue(entry, seen))

  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/token|password|secret|authorization|cookie/i.test(key)) output[key] = '[redacted]'
    else output[key] = serializableValue(entry, seen)
  }
  return output
}

function formatValues(values) {
  return values
    .map((value) => {
      if (typeof value === 'string') return redactString(value)
      return inspect(serializableValue(value), {
        breakLength: Infinity,
        compact: true,
        depth: 6,
        maxArrayLength: 50,
        maxStringLength: 16_000
      })
    })
    .join(' ')
}

function rotateIfNeeded(nextBytes) {
  const path = currentLogPath()
  if (!existsSync(path) || statSync(path).size + nextBytes <= MAX_LOG_BYTES) return

  const oldest = rotatedLogPath(ROTATED_LOG_COUNT)
  if (existsSync(oldest)) unlinkSync(oldest)
  for (let index = ROTATED_LOG_COUNT - 1; index >= 1; index -= 1) {
    const from = rotatedLogPath(index)
    if (existsSync(from)) renameSync(from, rotatedLogPath(index + 1))
  }
  renameSync(path, rotatedLogPath(1))
}

function appendLine(level, source, message, { bypassDedupe = false } = {}) {
  if (!logDirectory) return

  const sanitizedMessage = redactString(message)
    .replaceAll(String.fromCharCode(0), '')
    .slice(0, MAX_LOG_MESSAGE_LENGTH)
  const signature = `${level}|${source}|${sanitizedMessage}`
  if (!bypassDedupe) {
    if (occurrenceCounts.size >= MAX_DEDUPE_SIGNATURES && !occurrenceCounts.has(signature)) {
      occurrenceCounts.clear()
    }
    const count = occurrenceCounts.get(signature) ?? 0
    occurrenceCounts.set(signature, count + 1)
    if (count >= MAX_IDENTICAL_ENTRIES) {
      if (count === MAX_IDENTICAL_ENTRIES) {
        appendLine(
          'WARN',
          'diagnostics',
          `Further identical entries suppressed for this session: ${sanitizedMessage}`,
          { bypassDedupe: true }
        )
      }
      return
    }
  }

  const line = `${new Date().toISOString()} [${level}] [${source}] ${sanitizedMessage}\n`
  try {
    rotateIfNeeded(Buffer.byteLength(line))
    appendFileSync(currentLogPath(), line, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    // Logging must never crash the app or recurse through the patched console.
    originalConsoleError('[diagnostics] Failed to write production log:', error)
  }
}

export function logDiagnostic(level, source, ...values) {
  if (!productionDiagnosticsEnabled()) return
  const normalizedLevel = String(level).toUpperCase()
  if (!['INFO', 'WARN', 'ERROR'].includes(normalizedLevel)) return
  try {
    appendLine(normalizedLevel, source, formatValues(values))
  } catch (error) {
    originalConsoleError('[diagnostics] Failed to format production log entry:', error)
  }
}

function installProcessFailureHandlers() {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logDiagnostic('error', 'main:uncaught-exception', { origin }, error)
  })
  app.on('child-process-gone', (_event, details) => {
    logDiagnostic('error', 'electron:child-process-gone', details)
  })
}

export function installProductionDiagnostics() {
  if (loggingInstalled || !productionDiagnosticsEnabled()) return
  loggingInstalled = true

  try {
    logDirectory = join(app.getPath('userData'), 'logs')
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 })
  } catch (error) {
    logDirectory = null
    originalConsoleError('[diagnostics] Failed to initialize production logging:', error)
    return
  }

  console.warn = (...values) => {
    originalConsoleWarn(...values)
    logDiagnostic('warn', 'main', ...values)
  }
  console.error = (...values) => {
    originalConsoleError(...values)
    logDiagnostic('error', 'main', ...values)
  }

  installProcessFailureHandlers()
  appendLine(
    'INFO',
    'session',
    `Pylon ${app.getVersion()} started (platform=${process.platform}, arch=${process.arch}, ` +
      `electron=${process.versions.electron}, chromium=${process.versions.chrome})`,
    { bypassDedupe: true }
  )
}

export function attachWindowDiagnostics(win) {
  if (!productionDiagnosticsEnabled()) return
  const source = `renderer:${win.webContents.id}`

  win.webContents.on('render-process-gone', (_event, details) => {
    logDiagnostic('error', `${source}:process-gone`, details)
  })
  win.webContents.on('unresponsive', () => {
    logDiagnostic('error', `${source}:unresponsive`, 'Renderer stopped responding')
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logDiagnostic('error', `${source}:preload`, { preload: basename(preloadPath) }, error)
  })
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // ERR_ABORTED is generated by ordinary navigation cancellation.
      if (errorCode === -3) return
      logDiagnostic('error', `${source}:load`, {
        errorCode,
        errorDescription,
        url: redactString(validatedURL),
        isMainFrame
      })
    }
  )
}

function existingLogPaths() {
  if (!logDirectory) return []
  const paths = []
  for (let index = ROTATED_LOG_COUNT; index >= 1; index -= 1) {
    const path = rotatedLogPath(index)
    if (existsSync(path)) paths.push(path)
  }
  const current = currentLogPath()
  if (existsSync(current)) paths.push(current)
  return paths
}

function buildExportContents() {
  const sections = [
    'Pylon diagnostic logs',
    `Exported: ${new Date().toISOString()}`,
    `Version: ${app.getVersion()}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron}`,
    ''
  ]
  for (const path of existingLogPaths()) {
    sections.push(`===== ${basename(path)} =====`, readFileSync(path, 'utf8').trimEnd(), '')
  }
  return `${sections.join('\n')}\n`
}

async function exportLogs(event) {
  if (!productionDiagnosticsEnabled() || !logDirectory) {
    return { ok: false, error: 'Diagnostic logs are only available in the installed app.' }
  }

  try {
    const win = BrowserWindow.fromWebContents(event.sender)
    const date = new Date().toISOString().slice(0, 10)
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export Diagnostic Logs',
      defaultPath: join(app.getPath('documents'), `pylon-diagnostics-${date}.log`),
      filters: [{ name: 'Log file', extensions: ['log'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    if (existingLogPaths().some((path) => resolve(path) === resolve(filePath))) {
      return { ok: false, error: 'Choose a location outside Pylon’s internal log folder.' }
    }

    writeFileSync(filePath, buildExportContents(), { encoding: 'utf8', mode: 0o600 })
    return { ok: true }
  } catch (error) {
    logDiagnostic('error', 'diagnostics:export', error)
    return { ok: false, error: error?.message || 'The diagnostic log could not be exported.' }
  }
}

export function registerDiagnosticsIpc() {
  if (diagnosticsIpcRegistered) return
  diagnosticsIpcRegistered = true

  ipcMain.handle('diagnostics:is-available', () => productionDiagnosticsEnabled() && !!logDirectory)
  ipcMain.handle('diagnostics:export', exportLogs)
  ipcMain.on('diagnostics:log', (event, level, message) => {
    if (!productionDiagnosticsEnabled()) return
    if (level !== 'warn' && level !== 'error') return
    if (typeof message !== 'string') return
    logDiagnostic(
      level,
      `renderer:${event.sender.id}`,
      message.slice(0, MAX_RENDERER_MESSAGE_LENGTH)
    )
  })
}
