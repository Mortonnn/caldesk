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

/** localStorage 里身份文件的键 */
export const IDENTITY_KEY = 'caldesk.identity'

/**
 * 默认的同步服务器地址（发行版 = 作者自己部署的那套 Worker）。
 *
 * 留空 = 用这个，所以手机端不用填地址。
 */
export const DEFAULT_SERVER_URL = 'https://caldesk.ilikeu.cc.cd'

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
    return {
      accountId: parsed.accountId ?? '',
      deviceId: parsed.deviceId,
      deviceSecret: parsed.deviceSecret,
      deviceName: parsed.deviceName ?? '这台手机',
      serverUrl: parsed.serverUrl?.trim() || DEFAULT_SERVER_URL
    }
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
      // 传空字符串 = 用默认服务器
      serverUrl:
        patch.serverUrl === undefined
          ? existing.serverUrl
          : patch.serverUrl.trim() || DEFAULT_SERVER_URL,
      deviceName: patch.deviceName ?? existing.deviceName
    }
    saveMobileIdentity(next)
    return next
  }
  const created: MobileIdentity = {
    accountId: '',
    deviceId: randomUuid(),
    deviceSecret: randomHex(32),
    deviceName: patch.deviceName ?? '这台手机',
    serverUrl: patch.serverUrl?.trim() || DEFAULT_SERVER_URL
  }
  saveMobileIdentity(created)
  return created
}

export function isMobilePaired(id: MobileIdentity | null): boolean {
  return Boolean(id && id.accountId && id.deviceId && id.deviceSecret)
}

/* ------------------------------ 配对二维码 ------------------------------ */

export interface PairPayload {
  v: 1
  /** 服务器地址 */
  u: string
  /** pairId：手动输码时可以为空，服务端按 code 查 */
  p: string
  /** 6 位配对码 */
  c: string
}

export function buildPairText(p: PairPayload): string {
  return JSON.stringify(p)
}

export function parsePairText(text: string): PairPayload | null {
  try {
    const raw = JSON.parse(text) as Partial<PairPayload>
    if (!raw || raw.v !== 1) return null
    if (!raw.u || !raw.c) return null
    return { v: 1, u: String(raw.u), p: raw.p ? String(raw.p) : '', c: String(raw.c) }
  } catch {
    return null
  }
}
