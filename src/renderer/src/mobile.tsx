/**
 * 手机端入口（Capacitor / 移动浏览器）。
 *
 * 与桌面端 main.tsx 分开：桌面端用 App.tsx（Electron 宿主），
 * 这里用 MobileApp.tsx（纯手机界面）。
 *
 * 没有启动画面：MobileApp 用一个同步读出来的初始状态直接渲染，
 * 挂载那一刻就是真实界面，不需要等任何 Promise，也就不需要遮罩。
 */
import { createRoot } from 'react-dom/client'
import MobileApp from './MobileApp'
import { applyMaterials } from './design/platform'

// 材质档位要在首帧之前定好：安卓 WebView 走 plain 档（不做 backdrop-filter），
// 用户开了"减弱透明"走 opaque 档。写晚了会先看到一帧没有玻璃的界面。
applyMaterials()

createRoot(document.getElementById('root') as HTMLElement).render(<MobileApp />)
