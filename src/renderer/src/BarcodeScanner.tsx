/**
 * 手机端扫码：调用 WebView 内置的 BarcodeDetector。
 *
 * Android Chrome / WebView 支持 BarcodeDetector（Chrome 83+），
 * 不需要额外插件；不支持时退回到手动输入配对码。
 */
import { useEffect, useRef, useState } from 'react'

interface DetectedBarcode {
  rawValue: string
}

type Detector = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>
}

function getDetectorCtor(): (new (opts: { formats: string[] }) => Detector) | null {
  const w = window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => Detector }
  return w.BarcodeDetector ?? null
}

export function BarcodeScanner({
  onResult,
  onCancel,
  onError
}: {
  onResult: (text: string) => void
  onCancel: () => void
  onError: (msg: string) => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let alive = true
    const Ctor = getDetectorCtor()
    if (!Ctor) {
      onError('这台设备不支持扫码，请手动输入配对码')
      return
    }
    const detector = new Ctor({ formats: ['qr_code'] })

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        video.setAttribute('playsinline', 'true')
        void video.play()
        setReady(true)

        const tick = async (): Promise<void> => {
          if (!alive) return
          try {
            const codes = await detector.detect(video)
            const value = codes.find((c) => c.rawValue)?.rawValue
            if (value) {
              onResult(value)
              return
            }
          } catch {
            /* 单帧失败不算错误，继续扫 */
          }
          rafRef.current = requestAnimationFrame(() => void tick())
        }
        rafRef.current = requestAnimationFrame(() => void tick())
      })
      .catch((err) => {
        onError(`打不开摄像头：${(err as Error).message}`)
      })

    return () => {
      alive = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [onResult, onError])

  return (
    <div className="m-scanner-inner">
      <video ref={videoRef} className="m-scanner-video" muted playsInline />
      {!ready && <p className="m-scanner-hint">正在打开摄像头…</p>}
      <div className="m-scanner-frame" />
      <button className="m-scanner-cancel" onClick={onCancel}>
        取消
      </button>
    </div>
  )
}
