import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// main / preload 使用 electron-vite 的默认约定：
//   src/main/index.ts     -> out/main/index.js
//   src/preload/index.ts  -> out/preload/index.js
// 只有 renderer 需要显式声明多入口（主窗口 + 桌面浮窗）。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          mini: resolve(__dirname, 'src/renderer/mini.html')
        }
      }
    }
  }
})
