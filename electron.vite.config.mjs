import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Externalize node deps so the native uiohook-napi (.node) is loaded at runtime
  // from node_modules instead of being bundled by Rollup.
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    server: {
      proxy: {
        '/voice': {
          target: 'ws://47.16.222.82:3000',
          changeOrigin: true,
          ws: true
        }
      }
    }
  }
})