import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Setup from './Setup'
import { detectEnv } from './boot'
import './styles.css'

const env = detectEnv()
// 没有宿主也没有远端配置 → 先让用户填 Worker 地址（移动端/浏览器首次打开）
const needsSetup = !env.hasIpc && !env.hasRemote

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>{needsSetup ? <Setup /> : <App />}</StrictMode>
)
