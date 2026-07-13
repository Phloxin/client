import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Externalize node deps so the native uiohook-napi / audio-capture (.node)
  // are loaded at runtime from node_modules instead of being bundled by Rollup.
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.js'),
          // Separate entry forked as a utilityProcess for native audio capture.
          audioCaptureHost: resolve('src/main/audioCaptureHost.js')
        }
      }
    }
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
