import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import App from './App'
import Setup from './Setup'
import { detectEnv } from './boot'
import './styles.css'

const env = detectEnv()
// 没有宿主也没有远端配置 → 先让用户填 Worker 地址（移动端/浏览器首次打开）
const needsSetup = !env.hasIpc && !env.hasRemote

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {/* 系统的"减少动态"要管到 JS 动画，不能只靠 CSS 媒体查询 */}
    <MotionConfig reducedMotion="user">{needsSetup ? <Setup /> : <App />}</MotionConfig>
  </StrictMode>
)
