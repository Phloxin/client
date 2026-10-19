#!/usr/bin/env node
// Builds the E2EE worker's WASM (src/renderer/src/lib/e2ee/pkg) from the pylon-e2ee submodule.
// PYLON_E2EE_DIR builds from another checkout instead, e.g. PYLON_E2EE_DIR=../pylon-e2ee.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const override = process.env.PYLON_E2EE_DIR
const repo = override ? resolve(override) : join(projectRoot, 'pylon-e2ee')
const script = join(repo, 'build-wasm.mjs')

if (!existsSync(script)) {
  if (override) {
    console.error(`[build:e2ee] PYLON_E2EE_DIR=${override} has no build-wasm.mjs`)
  } else if (!existsSync(join(repo, 'Cargo.toml'))) {
    console.error(
      '[build:e2ee] the pylon-e2ee submodule is not checked out. Run:\n' +
        '  git submodule update --init pylon-e2ee'
    )
  } else {
    console.error(
      '[build:e2ee] the pinned pylon-e2ee commit predates build-wasm.mjs. Bump the submodule:\n' +
        '  git -C pylon-e2ee pull origin master && git add pylon-e2ee'
    )
  }
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [script, join(projectRoot, 'src', 'renderer', 'src', 'lib', 'e2ee', 'pkg')],
  { stdio: 'inherit' }
)
if (result.error) {
  console.error(`[build:e2ee] ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
