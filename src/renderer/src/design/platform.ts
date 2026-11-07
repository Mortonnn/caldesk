/**
 * 材质档位判定。
 *
 * 三档（写进 <html data-mat> / <html data-glass>）：
 *   full    —— 全部材质，含 backdrop-filter（Electron）
 *   plain   —— 去掉 backdrop-filter，只留染色 + 边框 + 阴影（安卓 WebView 默认）
 *   opaque  —— 用户开了"减弱透明"：全部不透明，布局零位移
 *
 * 为什么不用 @supports 探测：浏览器能"成功解析"一个它其实不渲染的滤镜值，
 * 探测会返回 true 然后什么都不画。平台判定是唯一可靠的方式。
 *
 * 为什么安卓默认 plain：没有可靠 GPU 合成的设备会掉进 Chromium 的软件合成路径，
 * 那条路径会把像素缓冲复制两份再在 CPU 上做高斯模糊 —— 一层玻璃就能吃掉整帧预算。
 */

const GLASS_PREF_KEY = 'caldesk.glass'

export type MaterialTier = 'full' | 'plain'
export type GlassMode = 'on' | 'opaque'

/** 有没有 Electron preload 注入的桥：这是区分桌面壳和 WebView 最可靠的信号 */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && Boolean((window as { caldesk?: unknown }).caldesk)
}

export function applyMaterials(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  /*
   * 默认 full，只有"看着就像廉价机"的时候降成 plain。
   *
   * 为什么不再按"是不是 WebView"一刀切：静态 backdrop-filter 在 Chromium WebView 里
   * 是能正常渲染的，真正会掉进软件合成路径的是**弱设备**（内存少、核心少、
   * 或者开了省电模式）。按硬件能力判断，比按宿主判断准。
   */
  const weak =
    (typeof navigator !== 'undefined' && (navigator as { deviceMemory?: number }).deviceMemory
      ? ((navigator as { deviceMemory?: number }).deviceMemory as number) < 4
      : false) ||
    (typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency < 4
      : false)
  const tier: MaterialTier = weak ? 'plain' : 'full'
  root.dataset.mat = tier

  // 用户偏好优先；系统级"降低透明"如果能读到也一并尊重
  let mode: GlassMode = 'on'
  try {
    if (localStorage.getItem(GLASS_PREF_KEY) === 'opaque') mode = 'opaque'
  } catch {
    /* 隐私模式读不到 localStorage：按默认来 */
  }
  if (typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-reduced-transparency: reduce)')
    if (mq.matches) mode = 'opaque'
  }
  root.dataset.glass = mode
}

/** 设置页里那个开关：写入偏好并立刻生效 */
export function setGlassMode(mode: GlassMode): void {
  try {
    localStorage.setItem(GLASS_PREF_KEY, mode)
  } catch {
    /* 存不下就算了，本次会话内生效 */
  }
  document.documentElement.dataset.glass = mode
}

export function getGlassMode(): GlassMode {
  try {
    return localStorage.getItem(GLASS_PREF_KEY) === 'opaque' ? 'opaque' : 'on'
  } catch {
    return 'on'
  }
}
