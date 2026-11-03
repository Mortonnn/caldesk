/**
 * 手机端配对页。
 *
 * 只留两种加入方式：扫二维码 / 输配对码。
 * 不堆小字说明 —— 界面自己说话。
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
      setStatus('等电脑批准…')
      // 轮询状态：批准后就能用了。
      // 注意只查状态，不要重复提交 join（重复 join 会因为设备已存在而报错）
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 1500))
        const st = await data.sync.pairStatus(pairText)
        if (!st.ok) continue
        if (st.data.status === 'approved') {
          setStatus('已批准')
          setTimeout(() => location.reload(), 600)
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
    // 地址留空 = 用默认服务器
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
          <h1>扫二维码</h1>
          <BarcodeScanner
            onCancel={() => setStep('welcome')}
            onError={(m) => setError(m)}
            onResult={(text) => {
              const parsed = parsePairText(text)
              if (!parsed) {
                setError('这不是配对二维码')
                return
              }
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

        <button className="primary-btn setup-btn" onClick={() => setStep('scan')}>
          扫二维码
        </button>

        <div className="setup-divider">或</div>

        <label className="setup-label">配对码</label>
        <input
          className="task-input setup-code"
          placeholder="6 位数字"
          inputMode="numeric"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        />

        <label className="setup-label">设备名</label>
        <input
          className="task-input"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
        />

        <label className="setup-label">服务器</label>
        <input
          className="task-input"
          placeholder={DEFAULT_SERVER_URL}
          value={url}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUrl(e.target.value)}
        />

        {error && <p className="cal-error">{error}</p>}
        {status && <p className="setup-hint">{status}</p>}

        <button
          className="primary-btn setup-btn"
          disabled={busy || code.length !== 6}
          onClick={() => {
            void data.sync.setServer(url.trim(), deviceName.trim())
            void joinByCode()
          }}
        >
          {busy ? '等待批准…' : '用配对码加入'}
        </button>
      </motion.div>
    </div>
  )
}
