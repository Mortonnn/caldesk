/**
 * 本机身份文件：%APPDATA%/caldesk/identity.json
 *
 * 里面有两样不能外传的东西：
 *  - deviceSecret：这台设备的凭证（服务端只存加盐哈希）
 *  - accountId：账号 id
 * 服务端存明文，所以没有账号密钥这一层。
 * 文件按 0600 写，且永远不会出现在同步请求里。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { DeviceIdentity } from '@shared/identity'

export interface StoredIdentity extends DeviceIdentity {
  /** 创建时间，仅用于展示 */
  createdAt?: number
}

export function identityPath(userDataDir: string): string {
  return join(userDataDir, 'identity.json')
}

export function loadIdentity(userDataDir: string): StoredIdentity | null {
  try {
    const p = identityPath(userDataDir)
    if (!existsSync(p)) return null
    const text = readFileSync(p, 'utf-8').replace(/^\uFEFF/, '')
    const raw = JSON.parse(text) as Partial<StoredIdentity>
    if (!raw.deviceId || !raw.deviceSecret) return null
    return {
      accountId: raw.accountId ?? '',
      deviceId: raw.deviceId,
      deviceSecret: raw.deviceSecret,
      deviceName: raw.deviceName ?? '这台电脑',
      serverUrl: raw.serverUrl ?? '',
      createdAt: raw.createdAt
    }
  } catch {
    return null
  }
}

export function saveIdentity(userDataDir: string, id: StoredIdentity): void {
  const p = identityPath(userDataDir)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(id, null, 2), { mode: 0o600 })
  try {
    chmodSync(p, 0o600)
  } catch {
    /* Windows 上权限位基本无效，忽略 */
  }
}

/** 只保证「这台设备有身份」，账号可以还没有（等创建或配对） */
export function ensureIdentity(
  userDataDir: string,
  patch: { serverUrl?: string; deviceName?: string } = {}
): StoredIdentity {
  const existing = loadIdentity(userDataDir)
  if (existing) {
    const next: StoredIdentity = {
      ...existing,
      serverUrl: patch.serverUrl ?? existing.serverUrl,
      deviceName: patch.deviceName ?? existing.deviceName
    }
    if (
      next.serverUrl !== existing.serverUrl ||
      next.deviceName !== existing.deviceName
    ) {
      saveIdentity(userDataDir, next)
    }
    return next
  }
  const created: StoredIdentity = {
    accountId: '',
    deviceId: randomUUID(),
    deviceSecret: randomBytes(32).toString('hex'),
    deviceName: patch.deviceName ?? '这台电脑',
    serverUrl: patch.serverUrl ?? '',
    createdAt: Date.now()
  }
  saveIdentity(userDataDir, created)
  return created
}

/** 账号 + 设备凭证都齐了才算「已配对」 */
export function isPaired(id: StoredIdentity | null): boolean {
  return Boolean(id && id.accountId && id.deviceId && id.deviceSecret)
}

export function maskDevice(id: string): string {
  return id ? `${id.slice(0, 8)}…` : ''
}
