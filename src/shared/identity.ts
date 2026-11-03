/**
 * 共享的同步身份类型。
 *
 * 账号体系：
 *  - accountId：账号 id，服务端生成，一台设备可属于多个账号（按需扩展）
 *  - deviceId / deviceSecret：这台设备的凭据，服务端只存 secret 的加盐哈希
 *  - 服务端存明文，所以没有账号密钥这一层
 */

/**
 * 默认的同步服务器地址。
 *
 * 发行版里这个地址就是作者自己部署的那套 Worker，所以用户**不用填地址**：
 * 桌面端和手机端都直接用它。留空 = 用这个。
 */
export const DEFAULT_SERVER_URL = 'https://caldesk.ilikeu.cc.cd'

/** 地址为空时回落到默认服务器 */
export function resolveServerUrl(url: string | undefined | null): string {
  const trimmed = (url ?? '').trim().replace(/\/$/, '')
  return trimmed || DEFAULT_SERVER_URL
}

export interface DeviceIdentity {
  /** 账号 id，服务端生成 */
  accountId: string
  deviceId: string
  /** hex 64 位，Bearer 凭证的一部分 */
  deviceSecret: string
  deviceName: string
  serverUrl: string
}

export interface DeviceInfo {
  deviceId: string
  name: string
  status: 'pending' | 'approved' | 'revoked'
  lastSeenAt: number | null
  lastIp: string | null
  current: boolean
}

/** 二维码里放的东西：新设备扫码即可拿到地址与配对信息 */
export interface PairPayload {
  v: 1
  u: string
  p: string
  c: string
}

export function pairingQrText(p: PairPayload): string {
  return JSON.stringify(p)
}

export function parsePairingQr(text: string): PairPayload | null {
  try {
    const raw = JSON.parse(text) as Partial<PairPayload>
    if (!raw || raw.v !== 1) return null
    if (!raw.u || !raw.c) return null
    // p 可以为空：手动输配对码时由服务端按 code 查
    return { v: 1, u: String(raw.u), p: raw.p ? String(raw.p) : '', c: String(raw.c) }
  } catch {
    return null
  }
}

export function bearerOf(id: { deviceId: string; deviceSecret: string }): string {
  return `Bearer ${id.deviceId}.${id.deviceSecret}`
}
