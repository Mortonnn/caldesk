/**
 * 二维码渲染：配对时给手机扫。
 *
 * 用 qrcode 库生成 SVG 字符串，直接内联到 DOM（不落 canvas，省一层依赖）。
 */
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export function QrCode({ text, size = 180 }: { text: string; size?: number }): React.ReactElement {
  const [svg, setSvg] = useState('')

  useEffect(() => {
    let alive = true
    void QRCode.toString(text, {
      type: 'svg',
      margin: 1,
      width: size,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' }
    }).then((out) => {
      if (alive) setSvg(out)
    })
    return () => {
      alive = false
    }
  }, [text, size])

  if (!svg) return <div className="qr-placeholder" style={{ width: size, height: size }} />
  return <div className="qr-svg" dangerouslySetInnerHTML={{ __html: svg }} />
}
