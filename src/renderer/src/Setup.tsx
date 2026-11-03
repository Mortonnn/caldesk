/**
 * 首次配置页（移动端 / 浏览器场景）。
 *
 * 桌面端由 Electron 注入 IPC，不需要这一步；
 * 手机上没有宿主，需要先扫电脑上的配对二维码（或手动输入配对码），
 * 由电脑批准后，这台手机才能同步。
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { BarcodeScanner } from './BarcodeScanner'
import { data } from './data'
import { DEFAULT_SERVER_URL, parsePairText, resolveServerUrl } from './mobileIdentity'

export default function Setup(): React.JSX.Element {
  const [step, setStep] = useState<'welcome' | 'scan'>('welcome')
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState('我的手机')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  /** 扫码或手输之后：提交入伙申请，然后等电脑批准 */
  async function join(pairText: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await data.sync.pairJoin(pairText)
      if (!res.ok) {
        setError(res.error)
        return
      }
      setStatus('申请已发送，等电脑批准…')
      // 轮询状态：批准后就能用了
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 1500))
        const again = await data.sync.pairJoin(pairText)
        if (!again.ok) continue
        if (again.data.status === 'approved') {
          setStatus('已批准，正在进入…')
          setTimeout(() => location.reload(), 600)
          return
        }
        if (again.data.status === 'rejected' || again.data.status === 'expired') {
          setError('电脑拒绝了这次配对')
          setStatus(null)
          return
        }
      }
      setStatus('还在等电脑批准，请到电脑上点「批准」')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function joinByCode(): Promise<void> {
    // 地址留空 = 用作者的服务器
    const u = resolveServerUrl(url)
    if (!/^https?:\/\//.test(u)) {
      setError('地址需要以 http:// 或 https:// 开头')
      return
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError('配对码是 6 位数字')
      return
    }
    // pairId 从二维码里才有；手动输入码时留空，服务端按 code 查
    await join(JSON.stringify({ v: 1, u, p: '', c: code.trim() }))
  }

  if (step === 'scan') {
    return (
      <div className="setup">
        <motion.div
          className="setup-card"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        >
          <h1>扫电脑上的二维码</h1>
          <p className="setup-desc">在电脑「设置 → 同步 → 手机配对」里生成二维码。</p>
          <BarcodeScanner
            onCancel={() => setStep('welcome')}
            onError={(m) => setError(m)}
            onResult={(text) => {
              const parsed = parsePairText(text)
              if (!parsed) {
                setError('这不是配对二维码')
                return
              }
              setUrl(parsed.u)
              void join(text)
            }}
          />
          {status && <p className="setup-hint">{status}</p>}
          {error && <p className="cal-error">{error}</p>}
        </motion.div>
      </div>
    )
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
          扫电脑上的配对二维码，电脑批准后，这台手机就能和它同步同一份数据。
        </p>

        <button className="primary-btn setup-btn" onClick={() => setStep('scan')}>
          扫一扫配对二维码
        </button>

        <div className="setup-divider">或手动输入</div>

        <label className="setup-label">Worker 地址（留空即用作者的服务器）</label>
        <input
          className="task-input"
          placeholder={DEFAULT_SERVER_URL}
          value={url}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUrl(e.target.value)}
        />

        <label className="setup-label">这台设备的名字</label>
        <input
          className="task-input"
          placeholder="我的手机"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
        />

        <label className="setup-label">配对码（电脑上显示的 6 位数字）</label>
        <input
          className="task-input"
          placeholder="123456"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />

        {error && <p className="cal-error">{error}</p>}
        {status && <p className="setup-hint">{status}</p>}

        <button
          className="primary-btn setup-btn"
          disabled={busy}
          onClick={() => {
            void data.sync.setServer(url.trim(), deviceName.trim())
            void joinByCode()
          }}
        >
          {busy ? '等待批准…' : '用配对码加入'}
        </button>

        <p className="setup-hint">
          配对码 5 分钟内有效，只能用一次。批准后这台设备才会出现在电脑的设备列表里。
        </p>
      </motion.div>
    </div>
  )
}
