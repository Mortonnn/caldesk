/**
 * 桌面浏览器里的首次进入页（没有 Electron 宿主时）。
 *
 * 与手机端同一套账号密码：注册或登录，之后所有设备共享同一份日历。
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { CalMark } from './icons'
import { DUR, EASE_OUT, riseIn } from './motion'
import { generateStrongPassword } from './password'
import { data } from './data'
import { DEFAULT_SERVER_URL, resolveServerUrl } from './mobileIdentity'

type Mode = 'login' | 'register'

export default function Setup({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('login')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void data.sync.getState().then((s) => setUrl(s.serverUrl || ''))
  }, [])

  async function submit(): Promise<void> {
    setError(null)
    setHint(null)
    const server = resolveServerUrl(url)
    if (!/^https?:\/\//.test(server)) {
      setError('先填服务器地址，例如 https://caldesk.workers.dev')
      return
    }
    if (!username.trim() || !password) {
      setError('请填写用户名和密码')
      return
    }
    setBusy(true)
    await data.sync.setServer(server, '')
    const res =
      mode === 'login'
        ? await data.sync.login({ username: username.trim(), password })
        : await data.sync.register({ username: username.trim(), password, invite: invite.trim() })
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (onDone) onDone()
    else location.reload()
  }

  function generate(): void {
    const pw = generateStrongPassword()
    setPassword(pw)
    setHint('已生成强密码并复制到剪贴板')
    void navigator.clipboard?.writeText(pw).catch(() => {})
  }

  return (
    <div className="setup">
      <motion.div
        className="setup-card"
        variants={riseIn(10)}
        initial="initial"
        animate="animate"
        transition={{ duration: DUR.page, ease: EASE_OUT }}
      >
        <h1>
          <CalMark size={20} />
          {mode === 'login' ? '登录 caldesk' : '创建账号'}
        </h1>

        <div className="seg-group">
          <button
            className={`seg-item ${mode === 'login' ? 'on' : ''}`}
            onClick={() => setMode('login')}
          >
            登录
          </button>
          <button
            className={`seg-item ${mode === 'register' ? 'on' : ''}`}
            onClick={() => setMode('register')}
          >
            注册
          </button>
        </div>

        <input
          className="task-input"
          placeholder="用户名"
          autoCapitalize="none"
          autoCorrect="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="task-input"
          type="password"
          placeholder="密码（至少 10 位，含大小写、数字、符号）"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === 'register' && (
          <input
            className="task-input"
            placeholder="邀请码（服务器设置了才需要）"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        )}
        <input
          className="task-input"
          placeholder={DEFAULT_SERVER_URL || '服务器地址，例如 https://caldesk.workers.dev'}
          autoCapitalize="none"
          autoCorrect="off"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />

        {error && <p className="cal-error">{error}</p>}
        {hint && <p className="setup-hint">{hint}</p>}

        <div className="note-actions">
          <button className="ghost" onClick={generate}>
            生成强密码
          </button>
          <button className="primary-btn" disabled={busy} onClick={() => void submit()}>
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </div>
      </motion.div>
    </div>
  )
}
