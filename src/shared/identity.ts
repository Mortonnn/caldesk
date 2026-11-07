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
 * 仓库源码里**不写死任何人的服务器**：这个常量在构建时由 vite 的 `define` 注入，
 * 取值来自构建环境变量 `CALDESK_DEFAULT_SERVER`（见 electron.vite.config.ts /
 * vite.mobile.config.ts）。自己部署官方安装包时设上它，公开仓库里就永远是空字符串。
 *
 * 为空表示"没有默认服务器"：界面要求用户手工填写自己的 Worker 地址，而不是
 * 悄悄连到某个人的机器上。
 */
declare const __CALDESK_DEFAULT_SERVER__: string

/** 构建期注入的默认服务器；没注入（tsc / 测试脚本 / 纯源码运行）时是空串 */
const BUILT_IN_DEFAULT_SERVER: string =
  typeof __CALDESK_DEFAULT_SERVER__ === 'string' ? __CALDESK_DEFAULT_SERVER__ : ''

export const DEFAULT_SERVER_URL = BUILT_IN_DEFAULT_SERVER

/**
 * 应用版本号，构建期从 package.json 注入。
 *
 * 渲染层拿不到 `app.getVersion()`（那是主进程的 API），但又要在「关于」里显示，
 * 所以沿用默认服务器那套 define 注入。主进程的 MCP serverInfo 走 app.getVersion()，
 * 两边最终都指向 package.json 的 version，不会各写一份。
 */
declare const __CALDESK_VERSION__: string

export const APP_VERSION: string =
  typeof __CALDESK_VERSION__ === 'string' ? __CALDESK_VERSION__ : '0.0.0'

/**
 * 开源仓库地址。
 *
 * 「关于」页里的入口指向这里，README 的徽章与 Releases 链接也用它，
 * 换仓库时只改这一处。
 */
export const PROJECT_URL = 'https://github.com/Mortonnn/caldesk'

/**
 * 这个构建有没有内置默认服务器。
 *
 * 界面用它决定要不要显示「恢复默认服务器」按钮 —— 源码自编译的版本没有默认值，
 * 显示一个点了没反应的按钮只会让人困惑。
 */
export function hasDefaultServer(): boolean {
  return BUILT_IN_DEFAULT_SERVER !== ''
}

/** 地址为空时回落到默认服务器 */
export function resolveServerUrl(url: string | undefined | null): string {
  const trimmed = (url ?? '').trim().replace(/\/+$/, '')
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

/* ------------------------------ 设备命名 ------------------------------ */

/**
 * `x-device-name` 请求头的编码 / 解码。
 *
 * HTTP 头只能承载 latin1，中文设备名（安卓 UA 里的机型、中文电脑名）直接塞进去，
 * 浏览器会让整个 fetch 抛 "Failed to fetch"，Node 端也一样。
 *
 * 以前的处理是「非 ASCII 一律换成 `?`」，于是「小米手机」变成 "????"，
 * 而且服务端每次同步都会用这个头覆盖 devices.name —— 名字就这么被冲掉了。
 * 现在改成百分号编码：头里全是 ASCII，服务端解回来，名字一个字节都不丢。
 */
export function encodeDeviceNameHeader(name: string): string {
  try {
    return encodeURIComponent(name).slice(0, 240)
  } catch {
    return 'unknown'
  }
}

/** 服务端侧的解码：没有 `%` 就当作老客户端发来的裸值，原样返回 */
export function decodeDeviceNameHeader(raw: string): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  if (!value.includes('%')) return value.slice(0, 80)
  try {
    return decodeURIComponent(value).slice(0, 80)
  } catch {
    return value.slice(0, 80)
  }
}

/** 老版本的占位名：遇到就当没有名字，重新按 设备名_月日时 生成 */
export const PLACEHOLDER_DEVICE_NAMES = new Set([
  '这台电脑',
  '这台手机',
  '我的手机',
  '我的电脑',
  '这台设备',
  '未命名设备'
])

/** 月日时，例如 11 月 4 日 13 点 → 110413 */
export function deviceStamp(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}`
}

/**
 * 默认设备名：<设备名>_<月日时>，例如 laptop_110413。
 *
 * 以前所有设备都叫"这台手机"，在设备列表里根本分不出谁是谁；
 * 默认名带上设备本身的名字和添加时间，一眼能认出是哪台、什么时候加的。
 */
export function defaultDeviceName(base: string, now = new Date()): string {
  const clean = base.trim().replace(/\s+/g, '') || 'unknown'
  return `${clean}_${deviceStamp(now)}`
}

/* ------------------------------ 本地服务 ------------------------------ */

/**
 * 本地 MCP / CLI 服务的默认端口。
 *
 * 主进程真的监听它（src/main/api.ts），渲染层的「AI 配置指南」也要把它写进给
 * Agent 的提示词里。原先是两处各写一个字面量 19283，改一处忘一处就会让用户
 * 照着提示词连到一个没人监听的端口，所以收在这里做唯一来源。
 * 运行时可用环境变量 `CALDESK_MCP_PORT` 覆盖。
 */
export const DEFAULT_MCP_PORT = 19283
