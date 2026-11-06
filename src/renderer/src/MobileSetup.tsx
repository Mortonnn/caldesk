/**
 * 手机端首次进入：账号密码登录 / 注册。
 *
 * 配对码与二维码都去掉了 —— 任何设备登录同一个账号，就同步同一份日历。
 * 注册时密码走同一套策略（数字 + 大小写 + 符号），并提供"生成强密码"。
 */
import { useEffect, useState } from 'react'
import { CalMark } from './icons'
import { data } from './data'
import { generateStrongPassword } from './password'
import { DEFAULT_SERVER_URL, resolveServerUrl } from './mobileIdentity'

type Mode = 'login' | 'register'

export function MobileSetup({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('login')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

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
    // 先记住服务器地址，登录请求才会打到这台服务器
    await data.sync.setServer(server, '')
    const res =
      mode === 'login'
        ? await data.sync.login({ username: username.trim(), password })
        : await data.sync.register({
            username: username.trim(),
            password,
            invite: invite.trim()
          })
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setHint(mode === 'login' ? '登录成功' : '账号已创建')
    setTimeout(onDone, 260)
  }

  function generate(): void {
    const pw = generateStrongPassword()
    setPassword(pw)
    setError(null)
    setHint('已生成强密码并复制到剪贴板')
    void navigator.clipboard?.writeText(pw).catch(() => {})
  }

  return (
    <div className="m-setup">
      <span className="m-setup-mark">
        <CalMark size={32} />
      </span>
      <h1>{mode === 'login' ? '登录 caldesk' : '创建账号'}</h1>
      <p>
        {mode === 'login'
          ? '同一个账号在电脑和手机上读写同一份日历'
          : '账号建在这台服务器上，其他设备登录同一个账号即可'}
      </p>

      <div className="m-auth-tabs" role="tablist">
        {(['login', 'register'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={`m-auth-tab ${mode === m ? 'on' : ''}`}
            onClick={() => {
              setMode(m)
              setError(null)
              setHint(null)
            }}
          >
            {m === 'login' ? '登录' : '注册'}
          </button>
        ))}
      </div>

      <label className="m-setup-label">用户名</label>
      <input
        className="m-setup-input"
        value={username}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="username"
        onChange={(e) => setUsername(e.target.value)}
      />

      <label className="m-setup-label">密码</label>
      <input
        className="m-setup-input"
        type="password"
        value={password}
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="m-auth-link" type="button" onClick={generate}>
        生成强密码
      </button>

      {mode === 'register' && (
        <>
          <label className="m-setup-label">邀请码</label>
          <input
            className="m-setup-input"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        </>
      )}

      <label className="m-setup-label">服务器</label>
      <input
        className="m-setup-input"
        value={url}
        placeholder={DEFAULT_SERVER_URL || 'https://你的-worker.workers.dev'}
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="url"
        onChange={(e) => setUrl(e.target.value)}
      />

      {error && <p className="m-setup-error">{error}</p>}
      {hint && <p className="m-setup-hint">{hint}</p>}

      <button className="m-setup-btn" disabled={busy} onClick={() => void submit()}>
        {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
      </button>
    </div>
  )
}
