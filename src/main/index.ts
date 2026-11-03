import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appendDayLine,
  clearSnapshots,
  createCalendar,
  createEvent,
  createNote,
  deleteCalendar,
  deleteDayLine,
  deleteEvent,
  deleteNote,
  getDayCell,
  getNote,
  initDb,
  listCalendars,
  listDayCells,
  listNotes,
  listOccurrences,
  listSnapshots,
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
import { startApiServer, type ApiHandle } from './api'
import {
  approveDevice,
  createAccount,
  listDevices,
  listPendingDevices,
  rejectDevice,
  revokeDevice,
  startPairing,
  syncNow
} from './sync'
import { ensureIdentity, isPaired, saveIdentity, type StoredIdentity } from './identity'
import { pairingQrText, parsePairingQr } from '@shared/identity'
import { migrateFromOldApp } from './migrate'

/* --------------------------- 命令行开关 --------------------------- */

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx >= 0) return process.argv[idx + 1] ?? null
  // 同时支持 --key=value 形式
  const prefixed = process.argv.find((a) => a.startsWith(`${flag}=`))
  return prefixed ? prefixed.slice(flag.length + 1) : null
}

const shotPath = argValue('--shot')
const shotMiniPath = argValue('--shot-mini')
/** `--theme system|light|dark`：截图验证时覆盖主题来源 */
const themeArg = argValue('--theme')
/** `--open-settings`：截图时展开设置浮层 */
const openSettings = process.argv.includes('--open-settings')
/** `--eval-file <path>`：截图前在渲染层执行一段脚本，用于端到端 UI 验证 */
const evalFile = argValue('--eval-file')

type ThemeMode = 'system' | 'light' | 'dark'

/** `--size 1920x1080`：强制逻辑视口尺寸，用于分辨率适配验证 */
function parseForcedSize(): { width: number; height: number } | null {
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

const MINI_WIDTH = 304
const MINI_HEIGHT = 320
const MINI_MARGIN = 16

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let apiHandle: ApiHandle | null = null
let tray: Tray | null = null
/** 退出流程中（用于区分"关窗到托盘"与"真正退出"） */
let isQuitting = false

/* ------------------------------ 单实例 ------------------------------ */

if (!app.requestSingleInstanceLock()) {
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
  themeMode: 'system'
}

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadState(): WindowState {
  try {
    const p = statePath()
    if (!existsSync(p)) return { ...DEFAULT_STATE }
    return { ...DEFAULT_STATE, ...(JSON.parse(readFileSync(p, 'utf-8')) as Partial<WindowState>) }
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

/** 右下角：贴着工作区右下放置，自动避开任务栏 */
function miniBounds(): { x: number; y: number; width: number; height: number } {
  const wa = screen.getPrimaryDisplay().workArea
  const width = Math.min(MINI_WIDTH, wa.width - MINI_MARGIN * 2)
  const height = Math.min(MINI_HEIGHT, wa.height - MINI_MARGIN * 2)
  return {
    width,
    height,
    x: wa.x + wa.width - width - MINI_MARGIN,
    y: wa.y + wa.height - height - MINI_MARGIN
  }
}

/* --------------------------- 主窗口 --------------------------- */

/* ------------------------------ 窗口显示/隐藏 ------------------------------ */

function appIconPath(): string {
  return join(app.getAppPath(), 'build', 'icon.png')
}

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

function createTray(): void {
  if (tray) return
  const image = nativeImage.createFromPath(appIconPath())
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }))
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
}

function createWindow(): void {
  const bounds = initialBounds()
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
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
    else mainWindow?.show()
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
    if (!isQuitting) {
      e.preventDefault()
      hideAllWindows()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
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
              console.log('[caldesk] eval ->', JSON.stringify(evalResult))
              await new Promise((r) => setTimeout(r, 900))
            }
            const image = await mainWindow!.webContents.capturePage()
            writeFileSync(shotPath, image.toPNG())
            console.log('[caldesk] screenshot ->', shotPath)
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
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: state.miniPinned,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  miniWindow.setAlwaysOnTop(state.miniPinned, 'floating')
  miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  miniWindow.on('ready-to-show', () => {
    if (state.miniVisible || shotMiniPath) miniWindow?.showInactive()
  })

  miniWindow.on('closed', () => {
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
            console.log('[caldesk] mini screenshot ->', shotMiniPath)
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
  for (const win of [mainWindow, miniWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('data:changed')
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

/* 本地回滚：list/clear 直接返回数据（渲染层按数组/数字消费），restore 走统一包装 */
ipcMain.handle('snapshots:list', () => listSnapshots())
handle('snapshots:restore', (id: string) => restoreSnapshot(id))
ipcMain.handle('snapshots:clear', () => clearSnapshots())

/* 同步：设备身份 + 配对 + 端到端加密 */
function identityOf(): StoredIdentity {
  return ensureIdentity(app.getPath('userData'))
}

handle('sync:get-state', () => {
  const id = identityOf()
  return {
    serverUrl: id.serverUrl,
    deviceId: id.deviceId,
    deviceName: id.deviceName,
    accountId: id.accountId,
    paired: isPaired(id)
  }
})

handle('sync:set-server', (url: string, deviceName: string) => {
  const id = ensureIdentity(app.getPath('userData'), {
    // 地址留空 = 用默认服务器
    serverUrl: url.trim().replace(/\/$/, ''),
    deviceName: deviceName.trim() || undefined
  })
  return { serverUrl: id.serverUrl, deviceName: id.deviceName, paired: isPaired(id) }
})

/** 首次建账号：这台电脑就是账号的第一个设备 */
ipcMain.handle('sync:create-account', async (_e, invite: string, accountName: string) => {
  try {
    const id = identityOf()
    if (!id.serverUrl) return { ok: false, error: '先填服务器地址' }
    const { accountId } = await createAccount(id, {
      invite: invite.trim(),
      accountName: accountName.trim()
    })
    const saved: StoredIdentity = { ...id, accountId }
    saveIdentity(app.getPath('userData'), saved)
    broadcastDataChanged()
    return { ok: true, data: { accountId } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

/** 二维码里的内容：地址 + 配对信息（配对码 + pairId） */
ipcMain.handle('sync:pair-start', async () => {
  try {
    const id = identityOf()
    if (!isPaired(id)) return { ok: false, error: '本机还没有账号，先创建' }
    const started = await startPairing(id)
    return {
      ok: true,
      data: {
        ...started,
        qr: pairingQrText({
          v: 1,
          u: id.serverUrl,
          p: started.pairId,
          c: started.code
        })
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

/**
 * 新设备扫码后加入：提交自己的身份，等已授权设备批准。
 * 桌面端也能用这个通道（比如给第二台电脑配对）。
 */
ipcMain.handle('sync:pair-join', async (_e, payloadText: string) => {
  try {
    const parsed = parsePairingQr(payloadText)
    if (!parsed) return { ok: false, error: '二维码内容不对' }
    const base = parsed.u.replace(/\/$/, '')
    const id = ensureIdentity(app.getPath('userData'), { serverUrl: base })
    const res = await fetch(`${base}/pair/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairId: parsed.p,
        code: parsed.c,
        deviceId: id.deviceId,
        accountSecret: id.deviceSecret,
        deviceName: id.deviceName
      }),
      signal: AbortSignal.timeout(20000)
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` }
    return await pairStatusOf(base, parsed, id)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

/**
 * 查这次配对的状态（不重复提交 join）。
 * 批准后服务端给出 accountId，这时把这台设备正式记进账号。
 */
ipcMain.handle('sync:pair-status', async (_e, payloadText: string) => {
  try {
    const parsed = parsePairingQr(payloadText)
    if (!parsed) return { ok: false, error: '二维码内容不对' }
    const base = parsed.u.replace(/\/$/, '')
    const id = ensureIdentity(app.getPath('userData'), { serverUrl: base })
    return await pairStatusOf(base, parsed, id)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

/** 查配对状态；批准时把 accountId 落盘 */
async function pairStatusOf(
  base: string,
  parsed: { p: string; c: string },
  id: StoredIdentity
): Promise<{ ok: true; data: { status: string } } | { ok: false; error: string }> {
  const st = await fetch(
    `${base}/pair/status?pairId=${encodeURIComponent(parsed.p)}` +
      `&deviceId=${encodeURIComponent(id.deviceId)}&code=${encodeURIComponent(parsed.c)}`,
    { signal: AbortSignal.timeout(20000) }
  )
  const body = (await st.json()) as { status?: string; accountId?: string }
  const status = body.status ?? 'pending'
  if (status === 'approved' && body.accountId && id.accountId !== body.accountId) {
    saveIdentity(app.getPath('userData'), { ...id, accountId: body.accountId })
    broadcastDataChanged()
  }
  return { ok: true, data: { status } }
}

ipcMain.handle('sync:pair-pending', async (_e, pairId: string) => {
  try {
    const list = await listPendingDevices(identityOf(), pairId)
    return { ok: true, data: list }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle('sync:pair-approve', async (_e, pairId: string, deviceId: string) => {
  try {
    await approveDevice(identityOf(), pairId, deviceId)
    return { ok: true, data: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
})

ipcMain.handle('sync:pair-reject', async (_e, pairId: string, deviceId: string) => {
  try {
    await rejectDevice(identityOf(), pairId, deviceId)
    return { ok: true, data: true }
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
  const report = await syncNow(id)
  // 拉下来的数据要立刻进界面，不能等用户翻月
  if (report.ok && report.pulled > 0) broadcastDataChanged()
  mainWindow?.webContents.send('sync:done', report)
  return report
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
  miniPinned: state.miniPinned
}))

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
  console.log('[caldesk] boot argv:', process.argv.slice(1).join(' '))
  state = loadState()
  initDb(app.getPath('userData'))

  // 无界面同步一次（用于自动化验证或计划任务）
  if (process.argv.includes('--sync-once')) {
    console.log('[caldesk] sync-once: 开始')
    const id = ensureIdentity(app.getPath('userData'))
    if (!isPaired(id)) {
      console.error('[caldesk] 本机还没有加入账号（identity.json 缺失或未配对）')
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
  console.log(
    `[caldesk] electron ${process.versions.electron} / node ${process.versions.node} / chrome ${process.versions.chrome}`
  )
  for (const d of screen.getAllDisplays()) {
    console.log(
      `[caldesk] display ${d.id} workArea ${d.workArea.width}x${d.workArea.height} @${d.scaleFactor}x`
    )
  }

  createWindow()
  createTray()

  // 开机自启（仅打包后注册，避免开发时把 electron.exe 写进启动项）
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: true })
    } catch (err) {
      console.error('[caldesk] 设置开机自启失败:', (err as Error).message)
    }
  }

  if (state.miniVisible || shotMiniPath) createMiniWindow()

  // 自动同步：启动后跑一次，之后每 5 分钟一次（仅在已配对时）
  const autoSync = (): void => {
    const id = ensureIdentity(app.getPath('userData'))
    if (!isPaired(id)) return
    void syncNow(id)
      .then((report) => {
        console.log(
          `[caldesk] auto-sync: push=${report.pushed} pull=${report.pulled} fail=${report.failed}` +
            (report.error ? ` err=${report.error}` : '')
        )
        mainWindow?.webContents.send('sync:done', report)
        if (report.ok && report.pulled > 0) broadcastDataChanged()
      })
      .catch((err) => console.error('[caldesk] auto-sync 异常:', (err as Error).message))
  }
  setTimeout(autoSync, 4000)
  const syncTimer = setInterval(autoSync, 5 * 60_000)
  app.on('before-quit', () => clearInterval(syncTimer))

  // 本地 MCP / CLI 服务：随机回环端口，供 agent 与命令行访问
  void startApiServer(app.getPath('userData'), {
    runSync: async (options: { full?: boolean }) => {
      const id = ensureIdentity(app.getPath('userData'))
      if (!isPaired(id)) return { ok: false, error: '本机还没有加入账号' }
      return syncNow(id, options)
    },
    runMigrate: async ({
      from,
      to,
      command,
      args
    }: {
      from: string
      to: string
      command?: string
      args?: string[]
    }) => {
      const exe = command ?? detectOldAppMcp()
      if (!exe) {
        return { ok: false, error: '没找到旧版「日历清单」的 desktopcal-mcp.exe' }
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return { ok: false, error: 'from / to 必须是 YYYY-MM-DD' }
      }
      return migrateFromOldApp({ command: exe, args, from, to })
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
    mainWindow?.webContents.send('theme:changed', payload)
    miniWindow?.webContents.send('theme:changed', payload)
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
