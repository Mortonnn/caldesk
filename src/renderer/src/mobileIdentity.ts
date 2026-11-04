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

import { PLACEHOLDER_DEVICE_NAMES, defaultDeviceName } from '@shared/identity'

/** localStorage 里身份文件的键 */
export const IDENTITY_KEY = 'caldesk.identity'

/**
 * 默认的同步服务器地址。
 *
 * 不在仓库里写死任何人的服务器：扫码配对时地址来自二维码，
 * 手输配对码时在配对页填自己的 Worker 地址。留空即要求手工填写。
 */
export const DEFAULT_SERVER_URL = ''

/** 地址为空时回落到默认服务器 */
export function resolveServerUrl(url: string | undefined | null): string {
  const trimmed = (url ?? '').trim().replace(/\/$/, '')
  return trimmed || DEFAULT_SERVER_URL
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

/** 手机默认设备名：型号_月日时，例如 24129PN74C_110413 */
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

export function loadMobileIdentity(): MobileIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<MobileIdentity>
    if (!parsed.deviceId || !parsed.deviceSecret) return null
    const stored = (parsed.deviceName ?? '').trim()
    // 老的"这台手机"没有区分度：第一次读到就换成 型号_月日时
    const deviceName = stored && !PLACEHOLDER_DEVICE_NAMES.has(stored) ? stored : autoDeviceName()
    const id: MobileIdentity = {
      accountId: parsed.accountId ?? '',
      deviceId: parsed.deviceId,
      deviceSecret: parsed.deviceSecret,
      deviceName,
      username: parsed.username,
      serverUrl: parsed.serverUrl?.trim() || DEFAULT_SERVER_URL
    }
    if (deviceName !== parsed.deviceName) saveMobileIdentity(id)
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
          : patch.serverUrl.trim(),
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
    serverUrl: patch.serverUrl?.trim() || DEFAULT_SERVER_URL
  }
  saveMobileIdentity(created)
  return created
}

export function isMobilePaired(id: MobileIdentity | null): boolean {
  return Boolean(id && id.accountId && id.deviceId && id.deviceSecret)
}
