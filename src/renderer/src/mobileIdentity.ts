/**
 * 移动端（Capacitor / 浏览器）用的同步身份与配对。
 *
 * 桌面端的主进程有自己的 identity.json（Node fs + node:crypto），
 * 这里给移动端一份等价实现：localStorage 存身份。
 *
 * 关键约束（跟主进程一致）：
 *  - deviceSecret 只用来拼 Bearer 头，服务端只存它的加盐哈希；
 *  - 服务端存明文，所以没有账号密钥这一层。
 */

import { DEFAULT_SERVER_URL, PLACEHOLDER_DEVICE_NAMES, defaultDeviceName } from '@shared/identity'

/** localStorage 里身份文件的键 */
export const IDENTITY_KEY = 'caldesk.identity'

/**
 * 默认的同步服务器地址 —— **和桌面端同一个来源**。
 *
 * 以前这里有一份独立的 `const DEFAULT_SERVER_URL = ''`，改了一边忘了另一边就会出现
 * "电脑有默认地址、手机没有"。现在统一从 `@shared/identity` 拿（构建期注入）。
 */
export { DEFAULT_SERVER_URL }

/** 这个构建有没有内置默认服务器（决定要不要显示「恢复默认服务器」） */
export { hasDefaultServer } from '@shared/identity'

/** 地址为空时回落到默认服务器 */
export function resolveServerUrl(url: string | undefined | null): string {
  return normalizeServerUrl(url) || DEFAULT_SERVER_URL
}

/**
 * 服务器地址的规范形态。
 *
 * 只去尾斜杠、不做别的：`https://a.dev/` 和 `https://a.dev` 是同一台服务器，
 * 存成两种会让缓存分区（账号@服务器）对不上，换一下写法就像换了一台服务器。
 */
export function normalizeServerUrl(url: string | undefined | null): string {
  return (url ?? '').trim().replace(/\/+$/, '')
}

export interface MobileIdentity {
  accountId: string
  deviceId: string
  deviceSecret: string
  deviceName: string
  serverUrl: string
  /** 登录用的用户名（配对时代的老身份没有） */
  username?: string
}

/** 浏览器/WebView 的机型：UA 里的 Android 型号，拿不到就 unknown */
export function deviceModelName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const m = /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|\))/i.exec(ua)
  const model = m?.[1]?.trim().replace(/\s+/g, '')
  if (model && model.toLowerCase() !== 'wv') return model
  return 'unknown'
}

/** 手机默认设备名：型号_月日时，例如 Pixel-7_110413 */
export function autoDeviceName(now = new Date()): string {
  return defaultDeviceName(deviceModelName(), now)
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  buf[6] = (buf[6] & 0x0f) | 0x40
  buf[8] = (buf[8] & 0x3f) | 0x80
  const hex = [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 服务端认可的凭据形状。
 *
 * 服务端对 secret 只认 64 位 hex（32 字节），deviceId 不能含 `.`（凭据是
 * `<deviceId>.<secret>`）、不能有空白。客户端这边以前不做校验，直接把手上的值
 * 发出去，于是本地一旦存着旧版本/测试残留的凭据，登录和注册都会收到
 * 「secret 必须是 64 位 hex」这种用户看不懂的报错 —— 而且换谁都会再遇到一次。
 * 这里在读身份时就自愈：形状不对的凭据永远认证不过，直接换一把新的。
 */
const SECRET_HEX_RE = /^[0-9a-f]{64}$/i
const MAX_DEVICE_ID_LEN = 128

function credentialLooksValid(deviceId: string, secret: string): boolean {
  if (!SECRET_HEX_RE.test(secret)) return false
  if (!deviceId || deviceId.length > MAX_DEVICE_ID_LEN) return false
  if (deviceId.includes('.')) return false
  if (/[\s\u0000-\u001f\u007f]/.test(deviceId)) return false
  return true
}

/** 给别处复用的凭据形状校验（比如导入的旧配置） */
export { credentialLooksValid }

export function loadMobileIdentity(): MobileIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MobileIdentity>
    if (!parsed.deviceId || !parsed.deviceSecret) return null
    const stored = (parsed.deviceName ?? '').trim()
    // 老的"这台手机"没有区分度：第一次读到就换成 型号_月日时
    const deviceName = stored && !PLACEHOLDER_DEVICE_NAMES.has(stored) ? stored : autoDeviceName()

    // 凭据形状不对 = 这份身份永远过不了服务端校验，换一把新的并清掉账号绑定
    const credentialOk = credentialLooksValid(parsed.deviceId, parsed.deviceSecret)
    const id: MobileIdentity = {
      accountId: credentialOk ? (parsed.accountId ?? '') : '',
      deviceId: credentialOk ? parsed.deviceId : randomUuid(),
      deviceSecret: credentialOk ? parsed.deviceSecret : randomHex(32),
      deviceName,
      username: credentialOk ? parsed.username : '',
      serverUrl: normalizeServerUrl(parsed.serverUrl) || DEFAULT_SERVER_URL
    }
    const changed =
      !credentialOk ||
      deviceName !== parsed.deviceName ||
      id.accountId !== (parsed.accountId ?? '')
    if (changed) saveMobileIdentity(id)
    return id
  } catch {
    return null
  }
}

export function saveMobileIdentity(id: MobileIdentity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(id))
}

export function ensureMobileIdentity(patch: {
  serverUrl?: string
  deviceName?: string
}): MobileIdentity {
  const existing = loadMobileIdentity()
  if (existing) {
    const next: MobileIdentity = {
      ...existing,
      // 空字符串 = 保持原样（只有显式传 undefined 才表示"没给"）；
      // 这样内部调用传 '' 不会把服务器地址和账号一起抹掉
      serverUrl:
        patch.serverUrl === undefined || patch.serverUrl.trim() === ''
          ? existing.serverUrl
          : normalizeServerUrl(patch.serverUrl),
      deviceName: patch.deviceName?.trim() || existing.deviceName
    }
    saveMobileIdentity(next)
    return next
  }
  const created: MobileIdentity = {
    accountId: '',
    deviceId: randomUuid(),
    deviceSecret: randomHex(32),
    deviceName: patch.deviceName?.trim() || autoDeviceName(),
    username: '',
    serverUrl: normalizeServerUrl(patch.serverUrl) || DEFAULT_SERVER_URL
  }
  saveMobileIdentity(created)
  return created
}

export function isMobilePaired(id: MobileIdentity | null): boolean {
  return Boolean(id && id.accountId && id.deviceId && id.deviceSecret)
}
