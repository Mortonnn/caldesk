import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * 构建期注入「默认同步服务器地址」。
 *
 * 源码里不写死任何人的服务器（`src/shared/identity.ts` 的 DEFAULT_SERVER_URL 由这里注入）。
 * 自己出安装包时设环境变量即可：
 *
 *   CALDESK_DEFAULT_SERVER=https://your-worker.example.com npm run dist
 *
 * 不设就是空串 —— 界面会要求用户填自己的 Worker 地址。
 * `__CALDESK_DEFAULT_SERVER__` 在源码里有 `declare const` 声明，tsc 不需要这个文件也能过。
 */
const DEFAULT_SERVER = process.env.CALDESK_DEFAULT_SERVER ?? ''

/** 版本号从 package.json 读，避免「关于」页和 package.json 各写一份 */
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }
).version

const DEFINE = {
  __CALDESK_DEFAULT_SERVER__: JSON.stringify(DEFAULT_SERVER),
  __CALDESK_VERSION__: JSON.stringify(PKG_VERSION)
}

// main / preload 使用 electron-vite 的默认约定：
//   src/main/index.ts     -> out/main/index.js
//   src/preload/index.ts  -> out/preload/index.js
// 只有 renderer 需要显式声明多入口（主窗口 + 桌面浮窗）。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: DEFINE,
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: DEFINE,
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    define: DEFINE,
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
