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
import { hostname } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  DEFAULT_SERVER_URL,
  PLACEHOLDER_DEVICE_NAMES,
  defaultDeviceName,
  type DeviceIdentity
} from '@shared/identity'

export interface StoredIdentity extends DeviceIdentity {
  /** 登录用的用户名（配对时代的老身份可能还没有） */
  username?: string
  /** 创建时间，仅用于展示 */
  createdAt?: number
}

/** 这台电脑的默认设备名：主机名_月日时，例如 Morton-laptop_110413 */
export function autoDeviceName(now = new Date()): string {
  let base = ''
  try {
    base = hostname().replace(/\.local$/i, '')
  } catch {
    base = ''
  }
  return defaultDeviceName(base || 'unknown', now)
}

function nameIsUsable(name: string | undefined): boolean {
  const value = (name ?? '').trim()
  return value.length > 0 && !PLACEHOLDER_DEVICE_NAMES.has(value)
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
    // 老版本的"这台电脑"没有区分度，第一次读到就换成 主机名_月日时 并落盘
    const deviceName = nameIsUsable(raw.deviceName) ? raw.deviceName!.trim() : autoDeviceName()
    const id: StoredIdentity = {
      accountId: raw.accountId ?? '',
      deviceId: raw.deviceId,
      deviceSecret: raw.deviceSecret,
      deviceName,
      username: raw.username,
      // 地址留空就等于没有默认服务器（需要自己填）
      serverUrl: raw.serverUrl?.trim() || DEFAULT_SERVER_URL,
      createdAt: raw.createdAt
    }
    if (id.deviceName !== raw.deviceName) saveIdentity(userDataDir, id)
    return id
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

/** 只保证「这台设备有身份」，账号可以还没有（等注册或登录） */
export function ensureIdentity(
  userDataDir: string,
  patch: { serverUrl?: string; deviceName?: string } = {}
): StoredIdentity {
  const existing = loadIdentity(userDataDir)
  if (existing) {
    const next: StoredIdentity = {
      ...existing,
      // 空字符串 = 保持原样：内部调用传 '' 不该把服务器地址和账号一起抹掉
      serverUrl:
        patch.serverUrl === undefined || patch.serverUrl.trim() === ''
          ? existing.serverUrl
          : patch.serverUrl.trim(),
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
    deviceName: nameIsUsable(patch.deviceName) ? patch.deviceName!.trim() : autoDeviceName(),
    serverUrl: patch.serverUrl?.trim() || DEFAULT_SERVER_URL,
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
