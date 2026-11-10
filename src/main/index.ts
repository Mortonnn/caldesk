import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appendDayLine,
  clearSnapshots,
  closeDb,
  createCalendar,
  createEvent,
  createNote,
  deleteCalendar,
  deleteDayLine,
  deleteEvent,
  deleteNote,
  getDayCell,
  getMeta,
  getNote,
  initDb,
  listCalendars,
  listDayCells,
  listNotes,
  listOccurrences,
  listSnapshots,
  localChangeToken,
  restoreSnapshot,
  search,
  setDayCellText,
  setDayLineDone,
  setOccurrenceDone,
  skipOccurrence,
  updateCalendar,
  updateDayLine,
  updateEvent,
  updateNote
} from './db'
import type { EventInput, NoteInput } from '@shared/types'
import {
  DEFAULT_MINI_HEIGHT,
  DEFAULT_MINI_WIDTH,
  isMiniRange,
  isMiniView,
  LEGACY_MINI_SIZE_PRESETS,
  MINI_MARGIN,
  MINI_MAX_HEIGHT,
  MINI_MAX_WIDTH,
  MINI_MIN_HEIGHT,
  MINI_MIN_WIDTH,
  MINI_SIZE_PRESETS,
  type MiniRange,
  type MiniView
} from '@shared/mini'
import { startApiServer, type ApiHandle } from './api'
import { migrateFromOldApp, killAllMigrateProcs } from './migrate'
import {
  accountInfo,
  claimAccount,
  listDevices,
  loginAccount,
  logoutDevice,
  registerAccount,
  remoteChangeToken,
  revokeDevice,
  syncNow
} from './sync'
import { ensureIdentity, isPaired, saveIdentity, type StoredIdentity } from './identity'

/* --------------------------- 命令行开关 --------------------------- */

/**
 * 取 `--flag value` 或 `--flag=value` 的值。
 * 注意 `--user-data --hidden` 这种"旗标后面直接跟了另一个旗标"的情况：
 * 不能把 `--hidden` 当成路径，否则会拿一个叫 "--hidden" 的目录去建库。
 */
export function argValue(flag: string): string | null {
  // 先看 --key=value（优先级高，允许空值)
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`))
  if (prefixed) {
    const value = prefixed.slice(flag.length + 1)
    return value.length > 0 ? value : null
  }
  const idx = process.argv.indexOf(flag)
  if (idx < 0) return null
  const next = process.argv[idx + 1]
  if (next === undefined || next.startsWith('--')) return null
  return next
}

const shotPath = argValue('--shot')
const shotMiniPath = argValue('--shot-mini')
/** `--theme system|light|dark`：截图验证时覆盖主题来源 */
const themeArg = argValue('--theme')
/** `--open-settings`：截图时展开设置浮层 */
const openSettings = process.argv.includes('--open-settings')
/** `--eval-file <path>`：截图前在渲染层执行一段脚本，用于端到端 UI 验证。
 *  只在未打包（源码/dev）时生效——打包后的二进制不接受任何「执行 JS」参数。 */
const evalFile = app.isPackaged ? null : argValue('--eval-file')
/** 登录自启时由启动项带上：只起托盘与浮窗，不弹主窗口 */
const startHidden = process.argv.includes('--hidden')
/** `--user-data <dir>`：端到端测试用独立数据目录，不碰真实身份与数据库 */
const userDataArg = argValue('--user-data')
if (userDataArg) {
  try {
    mkdirSync(userDataArg, { recursive: true })
    // setPath 要求目录真实存在，所以顺序不能颠倒
    app.setPath('userData', userDataArg)
  } catch (err) {
    // 目录不可用就退回默认数据目录，别让一个参数把启动流程打断
    console.error('[caldesk] --user-data 不可用，改用默认数据目录:', (err as Error).message)
  }
}

type ThemeMode = 'system' | 'light' | 'dark'

/**
 * 调试日志开关。
 *
 * 常驻日志只留"出问题必须看得到"的（启动参数、错误）；截图路径、每次自动同步的
 * 结果、显示器尺寸这些是开发期噪声，安装版用户看日志会一头雾水。
 * 打开方式：`--verbose` 或 `CALDESK_DEBUG=1`。
 */
const verbose =
  process.argv.includes('--verbose') ||
  process.env['CALDESK_DEBUG'] === '1' ||
  process.env['CALDESK_DEBUG'] === 'true'

function debugLog(...args: unknown[]): void {
  if (verbose) console.log(...args)
}

/** `--size 1920x1080`：强制逻辑视口尺寸，用于分辨率适配验证 */
export function parseForcedSize(): { width: number; height: number } | null {
  const raw = argValue('--size')
  if (!raw) return null
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(raw)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/* --------------------------- 常量 --------------------------- */

const MIN_WIDTH = 880
const MIN_HEIGHT = 580
/** 大屏上的舒适上限：4K 下也不铺满，避免元素被拉得过大 */
const MAX_WIDTH = 1680
const MAX_HEIGHT = 1060

/*
 * 浮窗尺寸/边距全部来自 @shared/mini：设置面板的预设、主进程的夹紧边界、
 * 浮窗自己的 CSS 最小宽高必须是同一组数，否则点「大」和实际窗口对不上。
 */

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
/** 浮窗尺寸/位置落盘的防抖 timer（拖动时 60fps 的 resize 不能每次都写文件） */
let miniSaveTimer: NodeJS.Timeout | null = null
let apiHandle: ApiHandle | null = null
let tray: Tray | null = null
/** 退出流程中（用于区分"关窗到托盘"与"真正退出"） */
let isQuitting = false

/* ------------------------------ 单实例 ------------------------------ */

/**
 * 第二个实例拿不到锁时只能退出。
 * 注意 `app.quit()` 是异步的（要等 before-quit/will-quit），模块剩下的代码还会继续执行：
 * 所以下面 whenReady 里必须再看一眼这个标记，否则第二个进程照样会开库、建托盘、闪一下窗口。
 */
const primaryInstance = app.requestSingleInstanceLock()

if (!primaryInstance) {
  // 已有实例在跑：直接退出，由既有实例把窗口唤到前台
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    // 浮窗与主窗口共存亡：主窗口回来时，若用户开着浮窗就一并恢复
    if (state.miniVisible) ensureMiniWindow()
  })
}

/* --------------------------- 窗口状态持久化 --------------------------- */

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
  miniVisible: boolean
  miniPinned: boolean
  /** 浮窗显示范围：1天 / 1周 / 1月，浮窗靠它决定拉几天数据 */
  miniRange: MiniRange
  /** 浮窗显示样式：列表 / 月视图 */
  miniView: MiniView
  /** 浮窗尺寸：拖 grip / 点预设后的真实宽高，下次启动按这个尺寸开 */
  miniWidth: number
  miniHeight: number
  /** 浮窗左上角；没保存过（首次启动）就贴右下角 */
  miniX?: number
  miniY?: number
  /** 登录 Windows 后自动启动：默认开，启动到托盘不弹主窗口 */
  autoStart: boolean
  /** 关闭主窗口时收进托盘（默认开）；关掉就变成"关闭即退出" */
  closeToTray: boolean
  /** 默认跟随系统 */
  themeMode: ThemeMode
}

const DEFAULT_STATE: WindowState = {
  width: 1180,
  height: 780,
  maximized: false,
  // 默认常驻：桌面浮窗是这个应用的主要用法，主窗口反而是偶尔打开的
  miniVisible: true,
  // 默认不压在所有窗口之上：需要时用浮窗上的图钉自己钉住
  miniPinned: false,
  // 默认按 1 月显示：新安装用户第一眼看到的是完整一月，而不是一屏只有今天
  miniRange: 'month',
  // 默认列表：现有日程流才是老用户熟悉的样子，月视图是可选
  miniView: 'list',
  // 默认比旧的 304×320 大一档，日视图能舒服放下 7~8 行
  miniWidth: DEFAULT_MINI_WIDTH,
  miniHeight: DEFAULT_MINI_HEIGHT,
  // 默认开机自启：这是个"每天都会看一眼"的日历，登录后安静待在托盘里最合适
  autoStart: true,
  // 默认关闭窗口进托盘：后台同步和浮窗都还活着
  closeToTray: true,
  themeMode: 'system'
}

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 数值夹紧：window-state.json 是外部文件，尺寸/坐标不能直接信 */
function clampNum(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * window-state.json 是磁盘上的外部文件：可能被手改、被旧版本写成别的类型、
 * 或者干脆是半截 JSON。字段必须逐个校验 ——
 *  - themeMode 传非法值会让 `nativeTheme.themeSource = ...` 在启动时抛错；
 *  - width/height 传字符串会让 BrowserWindow 拿到 NaN 边界。
 */
export function normalizeState(raw: unknown): WindowState {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const width = finiteOr(src.width, DEFAULT_STATE.width)
  const height = finiteOr(src.height, DEFAULT_STATE.height)
  const mode = src.themeMode
  const x = finiteOr(src.x, Number.NaN)
  const y = finiteOr(src.y, Number.NaN)
  const miniWidth = finiteOr(src.miniWidth, DEFAULT_STATE.miniWidth)
  const miniHeight = finiteOr(src.miniHeight, DEFAULT_STATE.miniHeight)
  // 旧版预设尺寸升级：落在旧档位上的窗口尺寸直接迁到新档位，避免被误判成「自定义」
  const legacyPresetIndex = LEGACY_MINI_SIZE_PRESETS.findIndex(
    (p) => Math.abs(p.width - miniWidth) <= 2 && Math.abs(p.height - miniHeight) <= 2
  )
  const normalizedMiniWidth =
    legacyPresetIndex >= 0 ? MINI_SIZE_PRESETS[legacyPresetIndex].width : miniWidth
  const normalizedMiniHeight =
    legacyPresetIndex >= 0 ? MINI_SIZE_PRESETS[legacyPresetIndex].height : miniHeight
  const miniX = finiteOr(src.miniX, Number.NaN)
  const miniY = finiteOr(src.miniY, Number.NaN)
  return {
    x: Number.isFinite(x) ? x : undefined,
    y: Number.isFinite(y) ? y : undefined,
    width: width > 0 ? width : DEFAULT_STATE.width,
    height: height > 0 ? height : DEFAULT_STATE.height,
    maximized: boolOr(src.maximized, DEFAULT_STATE.maximized),
    miniVisible: boolOr(src.miniVisible, DEFAULT_STATE.miniVisible),
    miniPinned: boolOr(src.miniPinned, DEFAULT_STATE.miniPinned),
    // 旧版本没有这些字段：类型/数值不对就整整齐齐回落到默认，别把 undefined 带进 BrowserWindow
    miniRange: isMiniRange(src.miniRange) ? src.miniRange : DEFAULT_STATE.miniRange,
    miniView: isMiniView(src.miniView) ? src.miniView : DEFAULT_STATE.miniView,
    miniWidth: clampNum(normalizedMiniWidth, MINI_MIN_WIDTH, MINI_MAX_WIDTH),
    miniHeight: clampNum(normalizedMiniHeight, MINI_MIN_HEIGHT, MINI_MAX_HEIGHT),
    miniX: Number.isFinite(miniX) ? miniX : undefined,
    miniY: Number.isFinite(miniY) ? miniY : undefined,
    autoStart: boolOr(src.autoStart, DEFAULT_STATE.autoStart),
    closeToTray: boolOr(src.closeToTray, DEFAULT_STATE.closeToTray),
    themeMode: mode === 'light' || mode === 'dark' || mode === 'system' ? mode : DEFAULT_STATE.themeMode
  }
}

export function loadState(): WindowState {
  try {
    const p = statePath()
    if (!existsSync(p)) return { ...DEFAULT_STATE }
    return normalizeState(JSON.parse(readFileSync(p, 'utf-8')))
  } catch {
    return { ...DEFAULT_STATE }
  }
}

let state: WindowState = { ...DEFAULT_STATE }

function persistState(): void {
  try {
    const p = statePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(state))
  } catch {
    /* 状态保存失败不应影响运行 */
  }
}

/* --------------------------- 多显示器布局 --------------------------- */

function clampToDisplays(b: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays()
  const overlaps = (d: Electron.Display): boolean =>
    b.x < d.workArea.x + d.workArea.width &&
    b.x + b.width > d.workArea.x &&
    b.y < d.workArea.y + d.workArea.height &&
    b.y + b.height > d.workArea.y

  const target = displays.find(overlaps) ?? screen.getPrimaryDisplay()
  const wa = target.workArea
  const width = Math.max(MIN_WIDTH, Math.min(b.width, Math.min(MAX_WIDTH, wa.width)))
  const height = Math.max(MIN_HEIGHT, Math.min(b.height, Math.min(MAX_HEIGHT, wa.height)))
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width)
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height)
  return { x, y, width, height }
}

function initialBounds(): Electron.Rectangle {
  // 注意：`--size` 不再改变窗口尺寸（Windows 会把超大窗口钳制到屏幕内），
  // 而是通过 CDP 覆盖视口来模拟目标分辨率，见 shot 分支。
  if (state.width > 0 && state.height > 0 && state.x !== undefined) {
    return clampToDisplays({
      x: state.x,
      y: state.y ?? 0,
      width: state.width,
      height: state.height
    })
  }
  const wa = screen.getPrimaryDisplay().workArea
  const width = Math.min(MAX_WIDTH, Math.round(wa.width * 0.94))
  const height = Math.min(MAX_HEIGHT, Math.round(wa.height * 0.94))
  return {
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  }
}

/**
 * 浮窗边界：尺寸用保存值（也可以由调用方临时覆盖），位置没保存过就贴右下角，
 * 最后统一夹进显示器工作区——拔掉副屏 / 改分辨率后，旧坐标可能整块落在屏外。
 *
 * 多屏判定优先用浮窗当前所在位置，其次用保存位置：用户把浮窗拖到副屏后，
 * 点「重置大小」应该继续待在副屏，而不是跳回主屏右下角。
 */
function miniBounds(override?: {
  width?: number
  height?: number
  /** 强制重新贴右下角（恢复默认尺寸时用），忽略保存/当前位置 */
  dock?: boolean
}): { x: number; y: number; width: number; height: number } {
  const current = miniWindow && !miniWindow.isDestroyed() ? miniWindow.getBounds() : null
  // 选屏用当前/保存的位置（dock 时也要选对显示器）；落点才区分是否强制贴右下角
  const displayX = current?.x ?? state.miniX
  const displayY = current?.y ?? state.miniY
  const anchorX = override?.dock ? undefined : displayX
  const anchorY = override?.dock ? undefined : displayY

  let wa = screen.getPrimaryDisplay().workArea
  if (displayX !== undefined && displayY !== undefined) {
    const hit = screen
      .getAllDisplays()
      .find(
        (d) =>
          displayX >= d.workArea.x &&
          displayX < d.workArea.x + d.workArea.width &&
          displayY >= d.workArea.y &&
          displayY < d.workArea.y + d.workArea.height
      )
    if (hit) wa = hit.workArea
  }

  // 先夹共享硬边界，再夹工作区：工作区比 MINI_MIN_* 还小的极端情况以工作区为准
  const width = Math.min(
    clampNum(override?.width ?? state.miniWidth, MINI_MIN_WIDTH, MINI_MAX_WIDTH),
    wa.width
  )
  const height = Math.min(
    clampNum(override?.height ?? state.miniHeight, MINI_MIN_HEIGHT, MINI_MAX_HEIGHT),
    wa.height
  )

  if (anchorX === undefined || anchorY === undefined) {
    return {
      width,
      height,
      x: wa.x + Math.max(0, wa.width - width - MINI_MARGIN),
      y: wa.y + Math.max(0, wa.height - height - MINI_MARGIN)
    }
  }
  // 越界时往屏内推，保证整块窗口都能看见
  return {
    width,
    height,
    x: Math.min(Math.max(anchorX, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(anchorY, wa.y), wa.y + wa.height - height)
  }
}

/**
 * 浮窗尺寸/位置落盘（250ms 防抖）。
 *
 * grip 拖拽会以 ~60fps 连续 setBounds，每次都写 window-state.json 既卡又没必要；
 * 统一在这里攒到停手后再落一次，并顺手通知主窗口刷新「浮窗大小」预设高亮。
 * 浮窗关着、窗口还没建时也要能落盘，所以不依赖窗口一定存在。
 */
function scheduleMiniStateSave(): void {
  if (miniSaveTimer) clearTimeout(miniSaveTimer)
  miniSaveTimer = setTimeout(() => {
    miniSaveTimer = null
    if (miniWindow && !miniWindow.isDestroyed()) {
      const bounds = miniWindow.getBounds()
      state.miniWidth = clampNum(bounds.width, MINI_MIN_WIDTH, MINI_MAX_WIDTH)
      state.miniHeight = clampNum(bounds.height, MINI_MIN_HEIGHT, MINI_MAX_HEIGHT)
      state.miniX = bounds.x
      state.miniY = bounds.y
    }
    persistState()
    // 设置面板的预设高亮要跟着真实尺寸走；浮窗本身不需要重读设置
    safeSend(mainWindow, 'settings:changed')
  }, 250)
}

/* --------------------------- 主窗口 --------------------------- */

/* ------------------------------ 窗口显示/隐藏 ------------------------------ */

function appIconPath(): string {
  return join(app.getAppPath(), 'build', 'icon.png')
}

/**
 * 托盘图标：**按 DPI 直接挑原生尺寸的 PNG**，一个像素都不缩。
 *
 * 以前是 `createFromPath(icon.png).resize({16,16})`：1024px 的应用图标里那几条
 * 1.5px 分隔线缩到 16px 后糊成一团白块，而且写死 16px 在 150%/200% 缩放的屏幕上
 * 会被 Windows 再放大一次 —— 这就是"托盘图标不够高清"的两个原因。
 *
 * 现在 `scripts/make-tray-icons.py` 按 16/20/24/32/40/48 各画一枚（对应
 * 100%/125%/150%/200%/250%/300% DPI），运行时按主显示器缩放比例选文件。
 *
 * 注意不要改成读 `tray.ico`：实测 `nativeImage.createFromPath(tray.ico)` 被 Skia
 * 解成单张 256×256 位图（`getSize()` 就是 256），交给系统还是得缩，白搭。
 */
function trayPngPath(): string {
  const base = join(app.getAppPath(), 'build')
  let scale = 1
  try {
    scale = screen.getPrimaryDisplay().scaleFactor || 1
  } catch {
    scale = 1
  }
  const px = Math.round(16 * scale)
  const exact = join(base, `tray-${px}.png`)
  if (existsSync(exact)) return exact
  // 非常规缩放（如 1.75）落到最近的更大尺寸，宁可缩小也不要放大
  for (const s of [16, 20, 24, 32, 40, 48]) {
    if (s >= px) {
      const p = join(base, `tray-${s}.png`)
      if (existsSync(p)) return p
    }
  }
  return join(base, 'tray-32.png')
}

function trayIconPath(): string {
  const base = join(app.getAppPath(), 'build')
  if (process.platform === 'darwin') return join(base, 'trayTemplate.png')
  return trayPngPath()
}

/** macOS 的模板图必须是单色的；其它平台用蓝色底板 */
const TRAY_IS_TEMPLATE = process.platform === 'darwin'

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (state.miniVisible) ensureMiniWindow()
}

/**
 * 收起主窗口（关到托盘）。
 * 浮窗是"桌面常驻件"，不跟着主窗口一起消失——否则一关主窗口它就没了，
 * 用户会觉得功能坏了。要关浮窗请用浮窗自己的关闭按钮或设置里的开关。
 */
function hideAllWindows(): void {
  mainWindow?.hide()
}

/** 确保浮窗存在且可见（不重复创建） */
function ensureMiniWindow(): void {
  if (!miniWindow || miniWindow.isDestroyed()) createMiniWindow()
  positionMini()
  miniWindow?.showInactive()
  state.miniVisible = true
  persistState()
}

/**
 * 把「开机自启动」写进系统登录项。
 *
 * 路径固定取当前 exe：升级、换安装目录之后再调一次就能修正旧路径。
 * 开发环境不写——否则注册表里会留下一个指向 electron.exe 的启动项。
 * 带上 --hidden，登录时只起托盘与浮窗，不会把主窗口怼到脸上。
 */
function applyAutoStart(): void {
  if (!app.isPackaged) return
  try {
    app.setLoginItemSettings({
      openAtLogin: state.autoStart,
      path: process.execPath,
      args: ['--hidden']
    })
  } catch (err) {
    console.error('[caldesk] 设置开机自启失败:', (err as Error).message)
  }
}

function createTray(): void {
  if (tray) return
  let image = nativeImage.createFromPath(trayIconPath())
  if (image.isEmpty()) {
    // 兜底：图标文件缺失（有人手工删了 build/）时退回旧行为，不要没有托盘
    image = nativeImage.createFromPath(appIconPath())
    if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 })
  }
  if (TRAY_IS_TEMPLATE && !image.isEmpty()) image.setTemplateImage(true)
  tray = new Tray(image)
  tray.setToolTip('caldesk')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      {
        label: '显示桌面浮窗',
        type: 'checkbox',
        checked: state.miniVisible,
        click: (item) => {
          if (item.checked) ensureMiniWindow()
          else {
            miniWindow?.hide()
            state.miniVisible = false
            persistState()
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', () => {
    if (mainWindow?.isVisible()) hideAllWindows()
    else showMainWindow()
  })
  // 拖到另一块不同缩放的显示器、或用户改了缩放比例时，换一枚对应像素尺寸的图
  screen.on('display-metrics-changed', () => {
    if (!tray || tray.isDestroyed()) return
    const next = nativeImage.createFromPath(trayIconPath())
    if (!next.isEmpty()) {
      if (TRAY_IS_TEMPLATE) next.setTemplateImage(true)
      tray.setImage(next)
    }
  })
}

/** 允许交给系统打开器（shell.openExternal）的协议 */
function isSafeExternalUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:'
  } catch {
    return false
  }
}

/** 允许在本窗口内导航的目标：自身页面（file://）或本机 dev server */
function isInAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'file:') return true
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
    }
    return false
  } catch {
    return false
  }
}

function createWindow(): void {  const bounds = initialBounds()
  const forced = parseForcedSize()

  mainWindow = new BrowserWindow({
    ...bounds,
    useContentSize: Boolean(forced),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // preload 只 import 了 electron + 纯类型，沙箱下可用；打开它让渲染进程
      // 拿回 Chromium 自己的 OS 级隔离，而不是只靠 contextIsolation 一层
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  if (state.maximized && !forced) mainWindow.maximize()

  const notifyMaximized = (): void => {
    mainWindow?.webContents.send('window:maximized', mainWindow.isMaximized())
  }
  mainWindow.on('maximize', notifyMaximized)
  mainWindow.on('unmaximize', notifyMaximized)

  mainWindow.on('ready-to-show', () => {
    if (shotPath) mainWindow?.showInactive()
    // 登录自启：只留托盘和浮窗，主窗口等用户点托盘再出来
    else if (!startHidden) mainWindow?.show()
  })

  const remember = (): void => {
    if (!mainWindow) return
    state.maximized = mainWindow.isMaximized()
    const b = state.maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    state.x = b.x
    state.y = b.y
    state.width = b.width
    state.height = b.height
    persistState()
  }

  for (const evt of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
    mainWindow.on(evt as 'resize', remember)
  }
  // 关闭 = 收进托盘（真退出走托盘菜单或 before-quit）
  mainWindow.on('close', (e) => {
    remember()
    if (isQuitting) return
    if (!state.closeToTray) {
      // 设置里关掉"关闭进托盘"后，点关闭就是退出
      isQuitting = true
      app.quit()
      return
    }
    e.preventDefault()
    hideAllWindows()
  })

  // 新窗口 / 外链：只放行常规网页协议。
  // 以前是无条件 shell.openExternal(url)，而 openExternal 会把 `file:` 交给系统执行器
  // （指向 exe 就等于运行它），`smb:` 还会带出 NTLM 凭据。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 顶层导航只允许应用自身（file:// 或本机 dev server）。
  // 否则一旦页面里出现外链/XSS，远程页面会占住这个 webContents，
  // 而 preload 注入的 IPC 桥还挂在上面。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInAppUrl(url)) event.preventDefault()
  })

  // 不用 <webview>，一律拒绝；也不授予任何浏览器权限（摄像头/通知/剪贴板…）
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  // 缩放：Ctrl +/-/0，跨不同 DPI 的显示器时用户可自行校正
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || !input.control) return
    const wc = mainWindow?.webContents
    if (!wc) return
    if (input.key === '=' || input.key === '+') wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 3))
    else if (input.key === '-') wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3))
    else if (input.key === '0') wc.setZoomLevel(0)
  })

  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const forced = parseForcedSize()
            if (forced) {
              // 用 CDP 覆盖视口：真实模拟 1080p~4K，不受物理屏幕尺寸钳制
              mainWindow!.webContents.debugger.attach('1.3')
              await mainWindow!.webContents.debugger.sendCommand(
                'Emulation.setDeviceMetricsOverride',
                {
                  width: forced.width,
                  height: forced.height,
                  deviceScaleFactor: 1,
                  mobile: false
                }
              )
              await new Promise((r) => setTimeout(r, 500))
            }
            if (themeArg) {
              await new Promise((r) => setTimeout(r, 240))
            }
            if (openSettings) {
              await mainWindow!.webContents.executeJavaScript(
                `document.querySelector('[aria-label="设置"]')?.click()`
              )
              await new Promise((r) => setTimeout(r, 520))
            }
            if (evalFile) {
              const code = readFileSync(evalFile, 'utf-8')
              const evalResult = await mainWindow!.webContents.executeJavaScript(code)
              debugLog('[caldesk] eval ->', JSON.stringify(evalResult))
              await new Promise((r) => setTimeout(r, 900))
            }
            const image = await mainWindow!.webContents.capturePage()
            writeFileSync(shotPath, image.toPNG())
            debugLog('[caldesk] screenshot ->', shotPath)
          } catch (err) {
            console.error('[caldesk] screenshot failed:', err)
          } finally {
            if (!shotMiniPath) app.quit()
          }
        })()
      }, 1200)
    })
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

/* --------------------------- 右下角常驻小窗 --------------------------- */

function createMiniWindow(): void {
  if (miniWindow && !miniWindow.isDestroyed()) return
  const b = miniBounds()

  miniWindow = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    // 透明窗口不能开 resizable：Electron 官方文档明确说 transparent 与 resizable
    // 在部分平台会互相破坏（透明/玻璃底直接失效）。尺寸调整统一走渲染层 grip 调
    // mini:set-size → setBounds（对透明窗口有效），所以这里只保留尺寸约束。
    resizable: false,
    minWidth: MINI_MIN_WIDTH,
    minHeight: MINI_MIN_HEIGHT,
    maxWidth: MINI_MAX_WIDTH,
    maxHeight: MINI_MAX_HEIGHT,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: state.miniPinned,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // preload 只 import 了 electron + 纯类型，沙箱下可用；打开它让渲染进程
      // 拿回 Chromium 自己的 OS 级隔离，而不是只靠 contextIsolation 一层
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  miniWindow.setAlwaysOnTop(state.miniPinned, 'floating')
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  miniWindow.on('ready-to-show', () => {
    if (state.miniVisible || shotMiniPath) miniWindow?.showInactive()
  })

  // 只拖位置时只有 move 会触发，只改尺寸时只有 resize 会触发，两个都要听
  miniWindow.on('resize', scheduleMiniStateSave)
  miniWindow.on('move', scheduleMiniStateSave)

  miniWindow.on('closed', () => {
    if (miniSaveTimer) {
      clearTimeout(miniSaveTimer)
      miniSaveTimer = null
    }
    miniWindow = null
    // 退出应用时窗口也会走 closed：这里若把 miniVisible 落盘成 false，
    // 用户"开着浮窗"的偏好就被自己的退出流程擦掉了，下次启动再也见不到浮窗。
    // 真正的关闭只有两条路——浮窗自己的关闭按钮、设置里的开关，它们各自落盘。
    if (isQuitting) return
    state.miniVisible = false
    persistState()
  })

  if (shotMiniPath) {
    miniWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const image = await miniWindow!.webContents.capturePage()
            writeFileSync(shotMiniPath, image.toPNG())
            debugLog('[caldesk] mini screenshot ->', shotMiniPath)
          } catch (err) {
            console.error('[caldesk] mini screenshot failed:', err)
          } finally {
            app.quit()
          }
        })()
      }, 1200)
    })
  }

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void miniWindow.loadURL(`${devUrl}/mini.html`)
  else void miniWindow.loadFile(join(__dirname, '../renderer/mini.html'))
}

function positionMini(): void {
  if (!miniWindow || miniWindow.isDestroyed()) return
  miniWindow.setBounds(miniBounds())
}

/* --------------------------- IPC --------------------------- */

/** 统一的 IPC 结果包装：业务异常不抛出，改为结构化返回，避免渲染层拿到裸 Error */
/**
 * 任一端改了数据，就把两个窗口都叫醒重读。
 * 浮窗和主窗口用的是同一个 SQLite，但各自有一份内存状态；
 * 不广播的话，在浮窗勾完任务，主窗口要等下次翻月才刷新——看起来就像两个库。
 */
function broadcastDataChanged(): void {
  notifyWindowsChanged()
  schedulePush()
}

/** 只通知窗口，不触发推送（拉取到远端改动时用，避免自己推自己） */
function notifyWindowsChanged(): void {
  for (const win of [mainWindow, miniWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('data:changed')
  }
}

/**
 * 给窗口发消息的统一入口。
 * 关键点：窗口可能已经被销毁（退出流程、关到托盘后又被系统回收），
 * 直接 `webContents.send` 会抛 "Object has been destroyed"，把整个异步流程带崩。
 */
function safeSend(win: BrowserWindow | null, channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed()) return
  try {
    if (payload === undefined) win.webContents.send(channel)
    else win.webContents.send(channel, payload)
  } catch (err) {
    console.error(`[caldesk] 向窗口发送 ${channel} 失败:`, (err as Error).message)
  }
}

/**
 * 设置类真值变了：主窗口和浮窗都要重读。
 * 浮窗靠这个广播立刻切「1天/1周/1月」，主窗口的设置面板靠它对齐开关和分段高亮。
 */
function broadcastSettingsChanged(): void {
  safeSend(mainWindow, 'settings:changed')
  safeSend(miniWindow, 'settings:changed')
}

/* --------------------------- 改动后自动推送 --------------------------- */

/**
 * 本地一有改动，就尽快把变更推给服务端，
 * 这样手机端不用干等 5 分钟的定时同步。
 *
 * 3 秒防抖：连续操作（比如勾选多个任务）只推一次。
 */
let pushTimer: NodeJS.Timeout | null = null
let pushing = false
let pushAgain = false

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushNow()
  }, 3000)
}

async function pushNow(): Promise<void> {
  const id = ensureIdentity(app.getPath('userData'))
  if (!isPaired(id)) return
  if (pushing) {
    // 正在推，标记一下稍后再推一次
    pushAgain = true
    return
  }
  pushing = true
  try {
    const report = await syncNow(id)
    debugLog(`[caldesk] auto-push: push=${report.pushed} fail=${report.failed}`)
    if (report.ok) {
      safeSend(mainWindow, 'sync:done', report)
      if (report.pulled > 0) notifyWindowsChanged()
    }
  } catch (err) {
    console.error('[caldesk] auto-push 异常:', (err as Error).message)
  } finally {
    pushing = false
    if (pushAgain) {
      pushAgain = false
      schedulePush()
    }
  }
}

/** 只读通道：这些不该触发刷新广播，否则读一次炸一次 */
const READ_CHANNELS = new Set([
  'app:ping',
  'calendars:list',
  'cells:range',
  'cells:get',
  'events:range',
  'notes:list',
  'notes:get',
  'search:query'
])

function handle<T>(channel: string, fn: (...args: never[]) => T): void {
  ipcMain.handle(channel, (_e, ...args) => {
    try {
      const data = fn(...(args as never[]))
      if (!READ_CHANNELS.has(channel)) broadcastDataChanged()
      return { ok: true as const, data }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
}

handle('calendars:list', () => listCalendars())
handle('calendars:create', (name: string, color?: string) => {
  const created = createCalendar(name, color)
  return { created, calendars: listCalendars() }
})
handle('calendars:update', (id: string, patch: { name?: string; color?: string }) =>
  updateCalendar(id, patch)
)
handle('calendars:delete', (id: string) => deleteCalendar(id))

/* 日格任务：语义与旧版 MCP 的 items_* 对齐 */
handle('cells:range', (calendarId: string, from: string, to: string) =>
  listDayCells(calendarId, from, to)
)
handle('cells:get', (calendarId: string, date: string) => getDayCell(calendarId, date))
handle('cells:setText', (calendarId: string, date: string, text: string) =>
  setDayCellText(calendarId, date, text)
)
handle('cells:appendLine', (calendarId: string, date: string, text: string) =>
  appendDayLine(calendarId, date, text)
)
handle('cells:updateLine', (calendarId: string, date: string, index: number, text: string) =>
  updateDayLine(calendarId, date, index, text)
)
handle('cells:deleteLine', (calendarId: string, date: string, index: number) =>
  deleteDayLine(calendarId, date, index)
)
handle('cells:setDone', (calendarId: string, date: string, index: number, done: boolean) =>
  setDayLineDone(calendarId, date, index, done)
)

/* 事件：语义与旧版 MCP 的 events_* 对齐 */
handle('events:range', (calendarId: string, from: string, to: string, kind?: string) =>
  listOccurrences(calendarId, from, to, (kind as 'all') ?? 'all')
)
handle('events:create', (input: EventInput) => createEvent(input))
handle('events:update', (id: string, patch: Partial<EventInput>) => updateEvent(id, patch))
handle('events:delete', (id: string) => {
  deleteEvent(id)
  return true
})
handle('events:setDone', (eventId: string, date: string, done: boolean) =>
  setOccurrenceDone(eventId, date, done)
)
handle('events:skip', (eventId: string, date: string) => {
  skipOccurrence(eventId, date)
  return true
})

/* 便签 */
handle('notes:list', (calendarId?: string) => listNotes(calendarId))
handle('notes:get', (id: string) => getNote(id))
handle('notes:create', (input: NoteInput) => createNote(input))
handle('notes:update', (id: string, patch: Partial<NoteInput>) => updateNote(id, patch))
handle('notes:delete', (id: string) => {
  deleteNote(id)
  return true
})

handle('search:query', (query: string, calendarId?: string, limit?: number) =>
  search(query, calendarId, limit)
)

/**
 * 变更探针：桌面端问"远端有没有新东西"。
 *
 * 远端水位和服务端比：本地记住上次看到的水位（sync:remoteToken），
 * 服务端的数字变大了就说明有东西要拉。
 * 不用拿本地水位比 —— 本地可能有还没推上去的行，比了会永远不一样。
 *
 * 这里直接用 ipcMain.handle（而不是 handle 包装）：这是个异步只读探针，
 * 既不能被当成写操作去广播 data:changed，也不能让 Promise 逃到返回值里。
 */
ipcMain.handle('sync:changes', async () => {
  const id = identityOf()
  // ok 用来区分"连不上"和"没有变更"：两者以前都是 remote 0，界面看不出区别
  if (!isPaired(id)) return { local: localChangeToken(), remote: 0, changed: false, ok: true }
  try {
    const remote = await remoteChangeToken(id)
    const known = Number(getMeta('sync:remoteToken') ?? 0)
    return { local: localChangeToken(), remote, changed: remote > known, ok: true }
  } catch {
    return { local: localChangeToken(), remote: 0, changed: false, ok: false }
  }
})

/* 本地回滚：list/clear 直接返回数据（渲染层按数组/数字消费），restore 走统一包装 */
ipcMain.handle('snapshots:list', () => listSnapshots())
handle('snapshots:restore', (id: string) => restoreSnapshot(id))
ipcMain.handle('snapshots:clear', () => clearSnapshots())

/* 同步：设备凭据（deviceId + secret）+ 用户名密码登录 */
function identityOf(): StoredIdentity {
  return ensureIdentity(app.getPath('userData'))
}

/**
 * 读同步状态。
 *
 * 注意用 ipcMain.handle 而不是 handle()：handle() 会把返回值包成 { ok, data }，
 * 而 preload 和渲染层都按裸对象消费（s.paired / s.serverUrl），
 * 包一层会让 paired 永远是 undefined —— 已登录也显示成"创建账号"。
 */
ipcMain.handle('sync:get-state', () => {
  const id = identityOf()
  return {
    serverUrl: id.serverUrl,
    deviceId: id.deviceId,
    deviceName: id.deviceName,
    accountId: id.accountId,
    username: id.username ?? '',
    paired: isPaired(id)
  }
})

/* 同上：saveSyncServer 直接读 res.serverUrl，不能包信封 */
ipcMain.handle('sync:set-server', (_e, url: string, deviceName: string) => {
  const before = identityOf()
  const nextUrl = url.trim().replace(/\/$/, '')
  // 换服务器等于换账号：旧账号在另一台服务器上，这里先退出登录
  const changed = nextUrl !== before.serverUrl
  const id = ensureIdentity(app.getPath('userData'), {
    serverUrl: nextUrl,
    deviceName: deviceName.trim() || undefined
  })
  if (changed && id.accountId) {
    const cleared: StoredIdentity = { ...id, accountId: '', username: '' }
    saveIdentity(app.getPath('userData'), cleared)
    broadcastDataChanged()
    return {
      serverUrl: cleared.serverUrl,
      deviceName: cleared.deviceName,
      paired: false,
      loggedOut: true
    }
  }
  return { serverUrl: id.serverUrl, deviceName: id.deviceName, paired: isPaired(id), loggedOut: false }
})

/* ------------------------------ 账号 ------------------------------ */

function saveAccount(id: StoredIdentity, accountId: string, username: string): StoredIdentity {
  const next: StoredIdentity = { ...id, accountId, username }
  saveIdentity(app.getPath('userData'), next)
  broadcastDataChanged()
  return next
}

/**
 * 服务端可能给这台设备换了一把新钥匙（它原来挂在别的账号下）。
 * 这时候要把新的 deviceId / secret 落到本地，否则下一次请求还是用旧凭据。
 */
function applyAuthCredentials(
  id: StoredIdentity,
  res: { deviceId?: string; secret?: string }
): StoredIdentity {
  if (!res.deviceId || !res.secret) return id
  if (res.deviceId === id.deviceId && res.secret === id.deviceSecret) return id
  const next: StoredIdentity = {
    ...id,
    deviceId: res.deviceId,
    deviceSecret: res.secret
  }
  saveIdentity(app.getPath('userData'), next)
  return next
}

/** 注册：建账号 + 这台电脑成为首台设备 */
ipcMain.handle(
  'sync:register',
  async (_e, input: { username: string; password: string }) => {
    try {
      const id = identityOf()
      if (!id.serverUrl) return { ok: false, error: '先填服务器地址' }
      const res = await registerAccount(id, input)
      const withKey = applyAuthCredentials(id, res)
      saveAccount(withKey, res.accountId, res.username)
      return { ok: true, data: res }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
)

/** 登录：任意设备登录同一账号，就绑到同一份数据上 */
ipcMain.handle('sync:login', async (_e, input: { username: string; password: string }) => {
  try {
    const id = identityOf()
    if (!id.serverUrl) return { ok: false, error: '先填服务器地址' }
    const res = await loginAccount(id, input)
    const withKey = applyAuthCredentials(id, res)
    saveAccount(withKey, res.accountId, res.username)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

/** 认领：早期（"配对"时代）留下的账号还没有用户名密码，用现有设备凭据补设一次 */
ipcMain.handle('sync:claim', async (_e, input: { username: string; password: string }) => {
  try {
    const id = identityOf()
    if (!id.accountId) return { ok: false, error: '本机还没有账号' }
    const res = await claimAccount(id, input)
    saveAccount(id, res.accountId, res.username)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle('sync:logout', async () => {
  const id = identityOf()
  try {
    await logoutDevice(id)
  } catch {
    /* 断网也要能退出本机 */
  }
  const next: StoredIdentity = { ...id, accountId: '', username: '' }
  saveIdentity(app.getPath('userData'), next)
  broadcastDataChanged()
  return { ok: true, data: { loggedOut: true } }
})

ipcMain.handle('sync:me', async () => {
  try {
    const info = await accountInfo(identityOf())
    return { ok: true, data: info }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle('sync:devices', async () => {
  try {
    const list = await listDevices(identityOf())
    return { ok: true, data: list }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle('sync:revoke-device', async (_e, deviceId: string) => {
  try {
    await revokeDevice(identityOf(), deviceId)
    return { ok: true, data: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle('sync:run', async () => {
  const id = identityOf()
  if (!isPaired(id)) return { ok: false, pushed: 0, pulled: 0, failed: 0, tables: {}, errors: [], error: '本机还没有加入账号' }
  try {
    const report = await syncNow(id)
    // 拉下来的数据要立刻进界面，不能等用户翻月
    if (report.ok && report.pulled > 0) broadcastDataChanged()
    safeSend(mainWindow, 'sync:done', report)
    return report
  } catch (err) {
    // 其它 sync:* 通道都用 ok:false 报错；这里抛出去会让渲染层的 invoke 变成
    // unhandled rejection（界面只看到"同步中"永远转圈），所以同样包成结构化结果。
    return {
      ok: false,
      pushed: 0,
      pulled: 0,
      failed: 0,
      tables: {},
      errors: [(err as Error).message],
      error: (err as Error).message
    }
  }
})

ipcMain.handle('app:ping', () => ({ ok: true, ts: Date.now() }))
ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  else mainWindow.maximize()
})
ipcMain.handle('window:close', () => mainWindow?.close())
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)

ipcMain.handle('settings:get', () => ({
  miniVisible: state.miniVisible,
  miniPinned: state.miniPinned,
  miniRange: state.miniRange,
  miniView: state.miniView,
  miniWidth: state.miniWidth,
  miniHeight: state.miniHeight,
  autoStart: state.autoStart,
  closeToTray: state.closeToTray
}))

ipcMain.handle('mcp:info', () => ({
  port: apiHandle?.port ?? null,
  url: apiHandle ? `http://127.0.0.1:${apiHandle.port}/mcp` : null
}))

ipcMain.handle('settings:set-auto-start', (_e, on: boolean) => {
  state.autoStart = Boolean(on)
  persistState()
  applyAutoStart()
  return state.autoStart
})

ipcMain.handle('settings:set-close-to-tray', (_e, on: boolean) => {
  state.closeToTray = Boolean(on)
  persistState()
  return state.closeToTray
})

ipcMain.handle('mini:set-visible', (_e, visible: boolean) => {
  if (visible) {
    ensureMiniWindow()
  } else {
    miniWindow?.hide()
    state.miniVisible = false
    persistState()
  }
  return state.miniVisible
})

ipcMain.handle('mini:toggle', () => {
  const visible = miniWindow?.isVisible() ?? false
  if (visible) {
    miniWindow?.hide()
    state.miniVisible = false
  } else {
    if (!miniWindow) createMiniWindow()
    positionMini()
    miniWindow?.showInactive()
    state.miniVisible = true
  }
  persistState()
  return state.miniVisible
})

ipcMain.handle('mini:hide', () => {
  miniWindow?.hide()
  state.miniVisible = false
  persistState()
})

ipcMain.handle('mini:pin', (_e, pinned: boolean) => {
  state.miniPinned = pinned
  miniWindow?.setAlwaysOnTop(pinned, 'floating')
  persistState()
  return pinned
})

/**
 * 切换浮窗显示范围。
 * IPC 是跨进程边界，渲染层传什么都不奇怪：非法值原样保留旧状态，并且照样把
 * 当前值返回去，调用方不用再查一次。
 */
ipcMain.handle('settings:set-mini-range', (_e, range: MiniRange) => {
  if (isMiniRange(range)) {
    state.miniRange = range
    persistState()
    broadcastSettingsChanged()
  }
  return state.miniRange
})

/** 切换浮窗显示样式：列表 / 月视图 */
ipcMain.handle('settings:set-mini-view', (_e, view: MiniView) => {
  if (isMiniView(view)) {
    state.miniView = view
    persistState()
    broadcastSettingsChanged()
  }
  return state.miniView
})

/**
 * 浮窗尺寸。
 *
 * 这是 resize grip 的高频通道（拖动时 ~60fps），所以这里只做三件事：
 * 夹紧、setBounds、在内存里更新 state.miniWidth/Height —— **不写盘**。
 * 落盘统一交给 createMiniWindow 里 resize/move 的 250ms 防抖，避免拖一次
 * 窗口把 window-state.json 写几十遍。
 */
ipcMain.handle('mini:set-size', (_e, width: number, height: number) => {
  // IPC 是跨进程边界：拖把手传的是屏幕坐标算出来的数，但别信它一定是有限数。
  // 拿到 NaN 直接 setBounds 会让窗口尺寸变成 NaN，有的 Windows 版本会弹系统错误框。
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: state.miniWidth, height: state.miniHeight }
  }
  const next = miniBounds({ width, height })
  state.miniWidth = next.width
  state.miniHeight = next.height
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.setBounds(next)
    state.miniX = next.x
    state.miniY = next.y
  }
  // 这里不广播、不落盘：setBounds 触发的 resize/move 会走 250ms 防抖，
  // 由那里统一 persist + 通知主窗口刷新预设高亮，避免拖动时每帧发 IPC。
  // 浮窗没建/隐藏时没有窗口事件，也要主动排一次落盘。
  scheduleMiniStateSave()
  return { width: next.width, height: next.height }
})

/** 恢复默认尺寸并重新贴右下角：低频操作，直接落盘一次 */
ipcMain.handle('mini:reset-size', () => {
  state.miniWidth = DEFAULT_MINI_WIDTH
  state.miniHeight = DEFAULT_MINI_HEIGHT
  state.miniX = undefined
  state.miniY = undefined
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.setBounds(miniBounds({ dock: true }))
  persistState()
  safeSend(mainWindow, 'settings:changed')
  return { width: state.miniWidth, height: state.miniHeight }
})

ipcMain.handle('app:open-main', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

/** 系统主题：跟随操作系统 / 强制浅色 / 强制深色 */
ipcMain.handle('theme:get-mode', () => state.themeMode)

ipcMain.handle('theme:set-mode', (_e, mode: ThemeMode) => {
  if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return state.themeMode
  state.themeMode = mode
  nativeTheme.themeSource = mode
  persistState()
  return state.themeMode
})

/* --------------------------- 生命周期 --------------------------- */

/** 探测旧版「日历清单」的 MCP 桥程序 */
function detectOldAppMcp(): string | null {
  const candidates = [
    join(process.env.APPDATA ?? '', 'CalendarTask', 'desktopcal-mcp.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'CalendarTask', 'desktopcal-mcp.exe'),
    'C:\\Program Files\\CalendarTask\\desktopcal-mcp.exe',
    'C:\\Program Files (x86)\\CalendarTask\\desktopcal-mcp.exe'
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  console.log('[caldesk] boot argv:', process.argv.slice(1).join(' '))
  state = loadState()
  initDb(app.getPath('userData'))

  // 无界面同步一次（用于自动化验证或计划任务）
  if (process.argv.includes('--sync-once')) {
    console.log('[caldesk] sync-once: 开始')
    const id = ensureIdentity(app.getPath('userData'))
    if (!isPaired(id)) {
      console.error('[caldesk] 本机还没有加入账号（identity.json 缺失或还没登录）')
      app.exit(2)
      return
    }
    try {
      const report = await syncNow(id)
      console.log('[caldesk] sync-once ->', JSON.stringify(report))
      app.exit(report.ok ? 0 : 1)
    } catch (err) {
      console.error('[caldesk] sync-once 异常:', (err as Error).message)
      app.exit(3)
    }
    return
  }

  // 主题来源必须在建窗之前设好，否则首帧会闪一次错误配色
  nativeTheme.themeSource = themeArg === 'light' || themeArg === 'dark' ? themeArg : state.themeMode
  debugLog(
    `[caldesk] electron ${process.versions.electron} / node ${process.versions.node} / chrome ${process.versions.chrome}`
  )
  for (const d of screen.getAllDisplays()) {
    debugLog(
      `[caldesk] display ${d.id} workArea ${d.workArea.width}x${d.workArea.height} @${d.scaleFactor}x`
    )
  }

  createWindow()
  createTray()

  // 开机自启（仅打包后注册，避免开发时把 electron.exe 写进启动项）
  applyAutoStart()

  if (state.miniVisible || shotMiniPath) createMiniWindow()

  // 自动同步：启动后跑一次，之后每 5 分钟一次（仅在本机已登录账号时）
  const autoSync = (): void => {
    const id = ensureIdentity(app.getPath('userData'))
    if (!isPaired(id)) return
    void syncNow(id)
      .then((report) => {
        debugLog(
          `[caldesk] auto-sync: push=${report.pushed} pull=${report.pulled} fail=${report.failed}` +
            (report.error ? ` err=${report.error}` : '')
        )
        safeSend(mainWindow, 'sync:done', report)
        if (report.ok && report.pulled > 0) notifyWindowsChanged()
      })
      .catch((err) => console.error('[caldesk] auto-sync 异常:', (err as Error).message))
  }
  const autoSyncTimer = setTimeout(autoSync, 4000)
  const syncTimer = setInterval(autoSync, 5 * 60_000)
  app.on('before-quit', () => {
    clearTimeout(autoSyncTimer)
    clearInterval(syncTimer)
  })

  // 本地 MCP / CLI 服务：只绑 127.0.0.1，端口默认 19283（可用 CALDESK_MCP_PORT 覆盖）
  void startApiServer(app.getPath('userData'), {
    version: app.getVersion(),    runSync: async (options: { full?: boolean }) => {
      const id = ensureIdentity(app.getPath('userData'))
      if (!isPaired(id)) return { ok: false, error: '本机还没有加入账号' }
      return syncNow(id, options)
    },
    runMigrate: async ({ from, to }: { from: string; to: string }) => {
      // 可执行文件只认主进程自己探测到的那一个，HTTP 侧传什么都不采信
      const exe = detectOldAppMcp()
      if (!exe) {
        return { ok: false, error: '没找到旧版「日历清单」的 desktopcal-mcp.exe' }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return { ok: false, error: 'from / to 必须是 YYYY-MM-DD' }
      }
      return migrateFromOldApp({ command: exe, from, to })
    },
    // CLI / MCP 写入后同样要刷新界面
    onDataChanged: broadcastDataChanged
  })
    .then((handle) => {
      apiHandle = handle
    })
    .catch((err) => {
      console.error('[caldesk] MCP 服务启动失败:', (err as Error).message)
    })

  app.on('before-quit', () => {
    clearTimeout(autoSyncTimer)
    clearInterval(syncTimer)
    if (pushTimer) {
      clearTimeout(pushTimer)
      pushTimer = null
    }
    killAllMigrateProcs()
    apiHandle?.close()
    apiHandle = null
  })

  const reflow = (): void => {
    if (mainWindow && !mainWindow.isMaximized() && !mainWindow.isDestroyed()) {
      const b = mainWindow.getBounds()
      const next = clampToDisplays(b)
      if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) {
        mainWindow.setBounds(next)
      }
    }
    positionMini()
  }
  screen.on('display-metrics-changed', reflow)
  screen.on('display-removed', reflow)
  screen.on('display-added', reflow)

  nativeTheme.on('updated', () => {
    const payload = {
      highContrast: nativeTheme.shouldUseHighContrastColors,
      dark: nativeTheme.shouldUseDarkColors
    }
    safeSend(mainWindow, 'theme:changed', payload)
    safeSend(miniWindow, 'theme:changed', payload)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // 有托盘时常驻后台：只有真正退出才结束进程
  if (isQuitting) app.quit()
})

// 兜底：quit 流程卡住时（如 HTTP 连接拖住、子进程未回收），2 秒后强制退出
// 保证「托盘退出 = 无残留进程」
app.on('will-quit', (e) => {
  e.preventDefault()
  // 这一步之后就是 app.exit(0)，不会再走任何收尾：
  // 在这里关库，让 WAL 做一次 checkpoint，不留 -wal/-shm 半截文件。
  try {
    closeDb()
  } catch (err) {
    console.error('[caldesk] 关闭数据库失败:', (err as Error).message)
  }
  app.exit(0)
})
