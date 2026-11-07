/**
 * 手机端首次进入：账号密码登录 / 注册。
 *
 * 配对码与二维码都去掉了 —— 任何设备登录同一个账号，就同步同一份日历。
 * 注册时密码走同一套策略（数字 + 大小写 + 符号），并提供"生成强密码"。
 *
 * 这里只有「非说不可」的字：标题、标签、密码规则、报错。标题下面那句解释
 * （"同一个账号在电脑和手机上读写同一份日历"）已经删了 —— 两个标签页
 * 「登录 / 注册」本身就把这件事说完了，多一行小字只是噪音。
 */
import { useEffect, useState } from 'react'
import { CalMark } from './icons'
import { data } from './data'
import { generateStrongPassword } from './password'
import { DEFAULT_SERVER_URL, hasDefaultServer, resolveServerUrl } from './mobileIdentity'

type Mode = 'login' | 'register'

/**
 * 密码最少位数，和 Worker 里的 `PASSWORD_MIN` 保持一致。
 * 只在「注册」时拦：老账号可能是规则收紧之前建的短密码，登录不能因此挡住。
 */
const PASSWORD_MIN = 10

export function MobileSetup({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('login')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
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
        : await data.sync.register({ username: username.trim(), password })
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
    /*
     * 剪贴板在 WebView 里不是必然可用（权限被关 / 非安全上下文）。
     * 以前不管成没成都说"已复制到剪贴板"，用户去粘贴才发现是空的。
     */
    const copy = navigator.clipboard?.writeText(pw)
    if (!copy) {
      setHint('已生成强密码（这台设备不让自动复制，请手动选中）')
      return
    }
    void copy.then(
      () => setHint('已生成强密码并复制到剪贴板'),
      () => setHint('已生成强密码（复制失败，请手动选中输入框里的密码）')
    )
  }

  return (
    <div className="m-setup">
      <span className="m-setup-mark">
        <CalMark size={32} />
      </span>
      <h1>{mode === 'login' ? '登录 caldesk' : '创建账号'}</h1>

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

      {/* 注册时把规则先讲清楚：等服务端回一句 400 才知道规则是什么，体验太差 */}
      {mode === 'register' && (
        <p
          className={`m-setup-rule ${
            password.length > 0 && password.length < PASSWORD_MIN ? 'is-warn' : ''
          }`}
        >
          {password.length > 0 && password.length < PASSWORD_MIN
            ? `还差 ${PASSWORD_MIN - password.length} 位（密码至少 ${PASSWORD_MIN} 位）`
            : `密码至少 ${PASSWORD_MIN} 位，建议同时含大小写、数字和符号`}
        </p>
      )}

      {/*
        密码 / 服务器两块之间的一行次级动作，宽度和下面的主按钮对齐、左右各一半：
          - 恢复默认服务器：只在构建里带了默认地址时才有；
          - 生成强密码：只在注册态 —— 登录页填的是用户自己的旧密码，
            给一个"生成强密码"等于劝他换掉正在用的密码。
        两个按钮同一套次级样式，谁也不抢下面那颗填色主按钮。
      */}
      {(hasDefaultServer() || mode === 'register') && (
        <div className="m-auth-row">
          {hasDefaultServer() && (
            <button
              className="m-auth-link"
              type="button"
              onClick={() => setUrl(DEFAULT_SERVER_URL)}
            >
              恢复默认服务器
            </button>
          )}
          {mode === 'register' && (
            <button className="m-auth-link" type="button" onClick={generate}>
              生成强密码
            </button>
          )}
        </div>
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

      <button
        className="m-setup-btn"
        disabled={busy || (mode === 'register' && password.length < PASSWORD_MIN)}
        onClick={() => void submit()}
      >
        {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
      </button>
    </div>
  )
}
