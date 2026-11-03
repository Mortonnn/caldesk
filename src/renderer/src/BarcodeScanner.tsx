/**
 * 手机端扫配对二维码。
 *
 * 走系统相机（Capacitor Camera 插件）拍一张照，
 * 拿到图片在本地解析二维码 —— 不经过任何服务器。
 *
 * 两条路：
 *  1. 系统相机（Capacitor 原生）：拍完返回临时文件，本地 jsQR 解析；
 *  2. 浏览器兜底：getUserMedia 实时取流 + BarcodeDetector。
 */
import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

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

/** 有 Capacitor 就用原生相机，否则退回浏览器 */
function hasNativeCamera(): boolean {
  const c = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  return typeof c.Capacitor?.isNativePlatform === 'function' && c.Capacitor.isNativePlatform()
}

/**
 * 本地解析二维码。
 *
 * 优先用 BarcodeDetector（浏览器原生，Chrome 83+），
 * 没有就用 jsQR 纯 JS 解码 —— 后者在 WebView 里也稳定可用。
 */
export async function decodeQrFromImage(source: HTMLImageElement): Promise<string | null> {
  const w = source.naturalWidth || source.width
  const h = source.naturalHeight || source.height
  if (!w || !h) return null

  // 先试原生检测器
  const Ctor = getDetectorCtor()
  if (Ctor) {
    try {
      const detector = new Ctor({ formats: ['qr_code'] })
      const found = await detector.detect(source)
      const value = found.find((c) => c.rawValue)?.rawValue
      if (value) return value
    } catch {
      /* 落到 jsQR */
    }
  }

  // jsQR：需要像素数据，画到 canvas 上取
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  const result = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
  return result?.data ?? null
}

/** 把文件读成 HTMLImageElement */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = (): void => resolve(img)
    img.onerror = (): void => reject(new Error('图片读不出来'))
    img.src = src
  })
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
  const [mode, setMode] = useState<'native' | 'live'>('live')
  const [busy, setBusy] = useState(false)
  const [shot, setShot] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  /** 浏览器兜底：实时取流 + BarcodeDetector */
  useEffect(() => {
    if (mode !== 'live') return
    let alive = true
    const Ctor = getDetectorCtor()
    if (!Ctor) {
      onError('这台设备不支持扫码，请改用系统相机拍照')
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
  }, [mode, onResult, onError])

  /** 系统相机：拍一张 → 本地解析 */
  async function takePhoto(): Promise<void> {
    setBusy(true)
    try {
      const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
      const photo = await Camera.getPhoto({
        quality: 80,
        allowEditing: false,
        resultType: CameraResultType.Uri,
        source: CameraSource.Camera,
        correctOrientation: true
      })
      const uri = photo.webPath ?? photo.path
      if (!uri) {
        onError('没拍到照片')
        return
      }
      setShot(uri)
      const img = await loadImage(uri)
      const text = await decodeQrFromImage(img)
      if (text) {
        onResult(text)
      } else {
        onError('这张照片里没有找到二维码，再拍一张试试')
      }
    } catch (err) {
      const msg = (err as Error).message
      // 用户取消拍照不算错误
      if (!/cancel/i.test(msg)) onError(`拍照失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  if (hasNativeCamera()) {
    return (
      <div className="m-scanner-inner">
        {shot ? (
          <img className="m-scanner-shot" src={shot} alt="拍到的二维码" />
        ) : (
          <div className="m-scanner-placeholder">
            <p>点下面的按钮，用系统相机拍下电脑上的配对二维码</p>
          </div>
        )}
        <button className="m-scanner-cancel" onClick={onCancel}>
          取消
        </button>
        <button className="m-scanner-shoot" disabled={busy} onClick={() => void takePhoto()}>
          {busy ? '解析中…' : shot ? '重拍' : '拍照'}
        </button>
      </div>
    )
  }

  return (
    <div className="m-scanner-inner">
      <video ref={videoRef} className="m-scanner-video" muted playsInline />
      <div className="m-scanner-frame" />
      <button className="m-scanner-cancel" onClick={onCancel}>
        取消
      </button>
    </div>
  )
}
