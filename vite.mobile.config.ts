import { resolve } from 'node:path'
import { renameSync, existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 手机端专用构建。
 *
 * 与桌面端（electron-vite）完全分开：
 *  - 入口是 src/renderer/mobile.html
 *  - 产物在 out/mobile/，index.html 就是入口
 *  - Capacitor 打 APK 时 webDir 指向 out/mobile
 *
 * 默认同步服务器同样由构建期注入（与桌面端同一套约定）：
 *   CALDESK_DEFAULT_SERVER=https://your-worker.example.com npm run build:mobile
 */
const DEFAULT_SERVER = process.env.CALDESK_DEFAULT_SERVER ?? ''

/** 版本号同桌面端一样从 package.json 注入（手机端「关于」要用） */
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }
).version

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  define: {
    __CALDESK_DEFAULT_SERVER__: JSON.stringify(DEFAULT_SERVER),
    __CALDESK_VERSION__: JSON.stringify(PKG_VERSION)
  },
  plugins: [
    react(),
    {
      // Vite 会按入口文件名命名产物，这里改成 index.html（Capacitor 认这个名）
      name: 'mobile-entry-rename',
      closeBundle() {
        const from = resolve(__dirname, 'out/mobile/mobile.html')
        const to = resolve(__dirname, 'out/mobile/index.html')
        if (existsSync(from)) renameSync(from, to)
      }
    }
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/mobile'),
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      // 入口在 src/renderer/mobile.html
      // 产物直接落在 out/mobile/index.html（Capacitor 从 webDir 根目录找入口）
      input: {
        index: resolve(__dirname, 'src/renderer/mobile.html')
      }
    }
  }
})
