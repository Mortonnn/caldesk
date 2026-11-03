/**
 * 手机端首次配置页：扫二维码 / 输配对码。
 *
 * 与桌面端的设置面板完全分开：手机用整屏卡片 + 大按钮。
 * 界面尽量少字 —— 能用按钮表达的就不写解释。
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { BarcodeScanner } from './BarcodeScanner'
import { CalMark } from './icons'
import { data } from './data'
import { DEFAULT_SERVER_URL, parsePairText, resolveServerUrl } from './mobileIdentity'

export function MobileSetup({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [scanning, setScanning] = useState(false)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('我的手机')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function join(pairText: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await data.sync.pairJoin(pairText)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setStatus('等电脑批准…')
      for (let i = 0; i < 80; i += 1) {
        await new Promise((r) => setTimeout(r, 1500))
        const st = await data.sync.pairStatus(pairText)
        if (!st.ok) continue
        if (st.data.status === 'approved') {
          setStatus('已批准')
          setTimeout(onDone, 500)
          return
        }
        if (st.data.status === 'rejected' || st.data.status === 'expired') {
          setError('电脑拒绝了这次配对')
          setStatus(null)
          return
        }
      }
      setStatus('还在等电脑批准')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function joinByCode(): Promise<void> {
    const u = resolveServerUrl(url)
    if (!/^\d{6}$/.test(code.trim())) {
      setError('配对码是 6 位数字')
      return
    }
    void data.sync.setServer(u, deviceName.trim())
    await join(JSON.stringify({ v: 1, u, p: '', c: code.trim() }))
  }

  if (scanning) {
    return (
      <div className="m-setup">
        <span className="m-setup-mark">
          <CalMark size={32} />
        </span>
        <h1>扫二维码</h1>
        <div className="m-scanner">
          <BarcodeScanner
            onCancel={() => setScanning(false)}
            onError={(m) => {
              setError(m)
              setScanning(false)
            }}
            onResult={(text) => {
              const parsed = parsePairText(text)
              if (!parsed) {
                setError('这不是配对二维码')
                setScanning(false)
                return
              }
              setUrl(parsed.u)
              void join(text)
            }}
          />
        </div>
        {status && <p className="m-setup-hint">{status}</p>}
        {error && <p className="m-setup-error">{error}</p>}
      </div>
    )
  }

  return (
    <div className="m-setup">
      <span className="m-setup-mark">
        <CalMark size={32} />
      </span>
      <h1>连接你的日历</h1>
      <p>在电脑端「设置 → 同步」里生成配对码，扫一下就连上了</p>

      <button className="m-setup-btn" onClick={() => setScanning(true)}>
        扫二维码
      </button>

      <div className="m-setup-divider">或</div>

      <label className="m-setup-label">配对码</label>
      <input
        className="m-setup-input m-setup-code"
        placeholder="6 位数字"
        inputMode="numeric"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />

      <label className="m-setup-label">设备名</label>
      <input
        className="m-setup-input"
        value={deviceName}
        onChange={(e) => setDeviceName(e.target.value)}
      />

      <label className="m-setup-label">服务器</label>
      <input
        className="m-setup-input"
        placeholder={DEFAULT_SERVER_URL || 'https://你的-worker.workers.dev'}
        value={url}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(e) => setUrl(e.target.value)}
      />

      {error && <p className="m-setup-error">{error}</p>}
      {status && <p className="m-setup-hint">{status}</p>}

      <button
        className="m-setup-btn"
        disabled={busy || code.length !== 6}
        onClick={() => void joinByCode()}
      >
        {busy ? '等待批准…' : '用配对码加入'}
      </button>
    </div>
  )
}
