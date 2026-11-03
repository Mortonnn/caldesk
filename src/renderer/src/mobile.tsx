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
