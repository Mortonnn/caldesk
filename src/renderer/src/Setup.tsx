/**
 * 首次配置页（移动端 / 浏览器场景）。
 *
 * 桌面端由 Electron 注入 IPC，不需要这一步；
 * 手机上没有宿主，需要用户填入 Cloudflare Worker 地址与同步令牌。
 */
import { useState } from 'react'
import { motion } from 'framer-motion'

const HOST_KEY = 'caldesk.http'

export default function Setup(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function connect(): Promise<void> {
    const u = url.trim().replace(/\/$/, '')
    const t = token.trim()
    if (!/^https?:\/\//.test(u)) {
      setError('地址需要以 http:// 或 https:// 开头')
      return
    }
    if (!t) {
      setError('请填写同步令牌')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${u}/api/calendars`, {
        headers: { authorization: `Bearer ${t}` }
      })
      if (!res.ok) {
        setError(`连接失败（HTTP ${res.status}）：请检查地址和令牌`)
        return
      }
      const list = (await res.json()) as unknown[]
      if (!Array.isArray(list)) {
        setError('服务端返回格式不正确')
        return
      }
      localStorage.setItem(HOST_KEY, JSON.stringify({ url: u, token: t }))
      location.reload()
    } catch (err) {
      setError(`无法连接：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup">
      <motion.div
        className="setup-card"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        <h1>连接你的日历</h1>
        <p className="setup-desc">
          填入部署好的 Cloudflare Worker 地址和同步令牌，之后所有设备共用同一份数据。
        </p>

        <label className="setup-label">Worker 地址</label>
        <input
          className="task-input"
          placeholder="https://caldesk-sync.xxx.workers.dev"
          value={url}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUrl(e.target.value)}
        />

        <label className="setup-label">同步令牌</label>
        <input
          className="task-input"
          type="password"
          placeholder="与 wrangler secret 里设置的一致"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />

        {error && <p className="cal-error">{error}</p>}

        <button className="primary-btn setup-btn" disabled={busy} onClick={() => void connect()}>
          {busy ? '连接中…' : '连接'}
        </button>

        <p className="setup-hint">
          令牌只保存在本机。桌面端在「设置 → 同步」里可以看到同一个地址。
        </p>
      </motion.div>
    </div>
  )
}
