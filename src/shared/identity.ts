/**
 * 共享的同步身份类型。
 *
 * 账号体系：
 *  - accountId：账号 id，服务端生成，一台设备可属于多个账号（按需扩展）
 *  - deviceId / deviceSecret：这台设备的凭据，服务端只存 secret 的加盐哈希
 *  - 服务端存明文，所以没有账号密钥这一层
 */

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
    if (!raw.u || !raw.p || !raw.c) return null
    return { v: 1, u: String(raw.u), p: String(raw.p), c: String(raw.c) }
  } catch {
    return null
  }
}

export function bearerOf(id: { deviceId: string; deviceSecret: string }): string {
  return `Bearer ${id.deviceId}.${id.deviceSecret}`
}
