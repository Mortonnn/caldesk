/**
 * 手机端入口（Capacitor / 移动浏览器）。
 *
 * 与桌面端 main.tsx 分开：桌面端用 App.tsx（Electron 宿主），
 * 这里用 MobileApp.tsx（纯手机界面）。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import MobileApp from './MobileApp'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>
)

/**
 * 启动画面由 index.html 内联渲染，等应用真正准备好再淡出。
 *
 * 不能用"React 挂载完就隐藏"：挂载那一刻还在读身份 / 拉日历，
 * 提前隐藏会露出同样的空白。MobileApp 在 ready 之后调这个。
 */
declare global {
  interface Window {
    __caldeskReady?: () => void
  }
}

let bootHidden = false
function hideBoot(): void {
  if (bootHidden) return
  bootHidden = true
  const boot = document.getElementById('boot')
  if (!boot) return
  boot.classList.add('gone')
  window.setTimeout(() => boot.remove(), 260)
}

window.__caldeskReady = hideBoot
// 兜底：JS 出错或接口一直不返回时，最多露 6 秒图标就交还给页面，别把用户永远挡在外面
window.setTimeout(hideBoot, 6000)
