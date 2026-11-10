/**
 * 主进程回归：不启动 Electron，用假的 electron 模块把 src/main/index.ts 跑起来。
 *
 * 做法：
 *   1. 把 src/main/*.ts + src/shared/*.ts 转成 ESM（@shared/* → 相对路径，electron → 假模块）；
 *   2. 假 electron 提供 app / ipcMain / BrowserWindow / Tray / Menu / nativeImage /
 *      nativeTheme / screen / shell，并把 ipcMain.handle 注册的通道都收下来；
 *   3. 真的 initDb 一个临时库，然后拿各种非法参数去捶每一条本地 IPC 通道，
 *      确认渲染层传垃圾值不会把主进程打崩、也不会抛裸 Error。
 *
 * 覆盖：--user-data / --size / window-state.json 解析、IPC 入参校验、
 *      preload 通道与主进程是否对得上、主题/设置开关、单实例分支、退出关库。
 *
 * 运行：node scripts/verify-db-main.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'caldesk-main-'))
const gen = join(tmp, 'gen')
const userData = join(tmp, 'user-data')

let failures = 0
let checks = 0

function ok(cond, msg) {
  checks += 1
  if (cond) return true
  failures += 1
  console.error('  ✗', msg)
  return false
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  return ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`)
}

/* ------------------------------ 假 electron ------------------------------ */

const ELECTRON_STUB = `
export const __state = {
  lock: process.env.CALDESK_STUB_LOCK !== '0',
  userData: process.env.CALDESK_STUB_USER_DATA,
  handlers: new Map(),
  ipcListeners: new Map(),
  appListeners: new Map(),
  sent: [],
  windows: [],
  quitCalled: false,
  exitCode: null,
  loginItem: null
}

const noop = () => {}

function makeWebContents() {
  return {
    send: (channel, payload) => __state.sent.push({ channel, payload }),
    on: noop,
    once: noop,
    setWindowOpenHandler: noop,
    executeJavaScript: async () => null,
    debugger: { attach: noop, sendCommand: async () => null },
    capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
    // 主进程给 session 挂权限拒绝钩子（历史安全加固），测试桩也得有这一层
    session: { setPermissionRequestHandler: noop }
  }
}

export class BrowserWindow {
  constructor(options = {}) {
    this.options = options
    this.webContents = makeWebContents()
    this.handlers = new Map()
    this._destroyed = false
    this._visible = false
    this._maximized = false
    __state.windows.push(this)
  }
  static getAllWindows() {
    return __state.windows.filter((w) => !w._destroyed)
  }
  isDestroyed() { return this._destroyed }
  isVisible() { return this._visible }
  isMinimized() { return false }
  isMaximized() { return this._maximized }
  maximize() { this._maximized = true }
  unmaximize() { this._maximized = false }
  restore() {}
  show() { this._visible = true }
  showInactive() { this._visible = true }
  hide() { this._visible = false }
  focus() {}
  close() { for (const cb of this.handlers.get('close') ?? []) cb({ preventDefault: noop }) }
  destroy() { this._destroyed = true; for (const cb of this.handlers.get('closed') ?? []) cb() }
  on(event, cb) {
    if (!this.handlers.has(event)) this.handlers.set(event, [])
    this.handlers.get(event).push(cb)
  }
  once(event, cb) { this.on(event, cb) }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  getBounds() { return { x: 10, y: 10, width: 1180, height: 780 } }
  getNormalBounds() { return this.getBounds() }
  setBounds() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  getZoomLevel() { return 0 }
  setZoomLevel() {}
  minimize() {}
  isFocused() { return false }
}

export const app = {
  isPackaged: false,
  requestSingleInstanceLock: () => __state.lock,
  quit: () => { __state.quitCalled = true },
  exit: (code) => { __state.exitCode = code },
  on: (event, cb) => {
    if (!__state.appListeners.has(event)) __state.appListeners.set(event, [])
    __state.appListeners.get(event).push(cb)
  },
  // 永不 resolve：把启动流程停在"注册完就绪回调"那一步，测试才能只测纯函数与 IPC
  whenReady: () => new Promise(() => {}),
  getPath: () => __state.userData,
  setPath: (name, value) => { if (name === 'userData') __state.userData = value },
  getAppPath: () => process.cwd(),
  setLoginItemSettings: (opts) => { __state.loginItem = opts },
  getLoginItemSettings: () => ({ openAtLogin: Boolean(__state.loginItem && __state.loginItem.openAtLogin) })
}

export const ipcMain = {
  handle: (channel, fn) => __state.handlers.set(channel, fn),
  on: (channel, fn) => __state.ipcListeners.set(channel, fn),
  removeHandler: noop
}

export const Menu = { buildFromTemplate: (template) => ({ template, items: template }) }
export const nativeImage = {
  createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
  createEmpty: () => ({ isEmpty: () => true })
}
export const nativeTheme = {
  themeSource: 'system',
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  on: noop
}
export const screen = {
  getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }],
  getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  on: noop
}
export const shell = { openExternal: async () => {} }
export class Tray {
  constructor() { this.listeners = new Map() }
  setToolTip() {}
  setContextMenu() {}
  on(event, cb) { this.listeners.set(event, cb) }
  destroy() {}
}
`

/* ------------------------------ 编译 ------------------------------ */

function transpile(src) {
  return ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true
    }
  }).outputText
}

function emitFile(srcRel, outRel, { shared = false } = {}) {
  const src = readFileSync(join(root, srcRel), 'utf-8')
  const js = transpile(src)
    // 相对路径补 .mjs（先做，避免和下面 @shared 的改写互相踩）
    .replace(/(from\s+')(\.\/[A-Za-z0-9_-]+)(')/g, '$1$2.mjs$3')
    .replace(/(from\s+')(@shared\/[A-Za-z0-9_]+)(')/g, (_m, a, spec, c) => {
      const name = spec.slice('@shared/'.length)
      return `${a}./${shared ? '' : 'shared/'}${name}.mjs${c}`
    })
    .replace(/(from\s+')electron(')/g, '$1./electron-stub.mjs$2')
  // 真构建产物是 CJS，所以源码里能用 __dirname；在 ESM 下补一个等价垫片
  const head = /__dirname/.test(src)
    ? "import { dirname as __shimDirname } from 'node:path'\nimport { fileURLToPath as __shimFileURL } from 'node:url'\nconst __dirname = __shimDirname(__shimFileURL(import.meta.url))\n"
    : ''
  const out = join(gen, outRel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, head + js)
}

mkdirSync(gen, { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(gen, 'electron-stub.mjs'), ELECTRON_STUB)

for (const file of readdirSync(join(root, 'src/shared'))) {
  if (!file.endsWith('.ts')) continue
  emitFile(join('src/shared', file), join('shared', file.replace(/\.ts$/, '.mjs')), { shared: true })
}
for (const file of readdirSync(join(root, 'src/main'))) {
  if (!file.endsWith('.ts')) continue
  emitFile(join('src/main', file), file.replace(/\.ts$/, '.mjs'))
}

process.env.CALDESK_STUB_USER_DATA = userData
process.env.CALDESK_STUB_LOCK = '1'
// index.ts 在模块顶层就解析参数：导入前先把 argv 摆成一个干净的形状
process.argv = ['electron', 'index.mjs']

try {
  const stub = await import(pathToFileURL(join(gen, 'electron-stub.mjs')).href)
  const main = await import(pathToFileURL(join(gen, 'index.mjs')).href)
  const db = await import(pathToFileURL(join(gen, 'db.mjs')).href)
  db.initDb(userData)

  const state = stub.__state

  /* ---------------------- 1. 命令行参数 ---------------------- */

  console.log('命令行：--user-data / --size / 旗标边界')
  const withArgv = (argv, fn) => {
    const backup = process.argv
    process.argv = argv
    try {
      return fn()
    } finally {
      process.argv = backup
    }
  }
  eq(withArgv(['electron', '--user-data', 'D:/x'], () => main.argValue('--user-data')), 'D:/x', '空格形式取值')
  eq(withArgv(['electron', '--user-data=D:/y'], () => main.argValue('--user-data')), 'D:/y', '等号形式取值')
  eq(withArgv(['electron', '--user-data='], () => main.argValue('--user-data')), null, '等号后面是空值当没给')
  eq(withArgv(['electron', '--user-data'], () => main.argValue('--user-data')), null, '旗标在末尾当没给')
  eq(
    withArgv(['electron', '--user-data', '--hidden'], () => main.argValue('--user-data')),
    null,
    '旗标后面跟着另一个旗标时不会把旗标当路径'
  )
  eq(withArgv(['electron'], () => main.argValue('--user-data')), null, '完全没给返回 null')

  eq(withArgv(['electron', '--size', '1920x1080'], () => main.parseForcedSize()), { width: 1920, height: 1080 }, '--size 解析')
  eq(withArgv(['electron', '--size', '99x99'], () => main.parseForcedSize()), null, '过小的尺寸被拒绝')
  eq(withArgv(['electron', '--size', '1920X1080'], () => main.parseForcedSize()), null, '大写 X 不认（保持严格）')
  eq(withArgv(['electron', '--size', '1920x1080x2'], () => main.parseForcedSize()), null, '多余段被拒绝')
  eq(withArgv(['electron'], () => main.parseForcedSize()), null, '没给 --size 返回 null')

  /* ---------------------- 2. window-state.json ---------------------- */

  console.log('窗口状态：坏文件 / 类型错乱不能把启动搞崩')
  eq(main.normalizeState(null).themeMode, 'system', 'null 状态回落到默认主题')
  eq(main.normalizeState({ themeMode: 'banana' }).themeMode, 'system', '非法 themeMode 被拒绝')
  eq(main.normalizeState({ themeMode: 'dark' }).themeMode, 'dark', '合法 themeMode 保留')
  eq(main.normalizeState({ width: '1800', height: null }).width, 1180, '字符串宽度被替换成默认值')
  eq(main.normalizeState({ width: 0, height: -5 }).height, 780, '非正数高度被替换成默认值')
  eq(main.normalizeState({ width: Number.NaN }).width, 1180, 'NaN 宽度被替换成默认值')
  eq(main.normalizeState({ x: 'abc', y: null }).x, undefined, '非法坐标被丢弃')
  eq(main.normalizeState({ x: 100, y: 200 }).x, 100, '合法坐标保留')
  eq(main.normalizeState({ maximized: 'yes', closeToTray: 0 }).maximized, false, '非布尔值回落默认')
  eq(main.normalizeState('not-an-object').miniVisible, true, '根本不是对象时整份回落默认')
  eq(main.normalizeState({ miniRange: 'year' }).miniRange, 'month', '非法浮窗范围回落 1月')
  eq(main.normalizeState({ miniRange: 'week' }).miniRange, 'week', '合法浮窗范围保留')
  eq(main.normalizeState({ miniView: 'gallery' }).miniView, 'list', '非法浮窗样式回落列表')
  eq(main.normalizeState({ miniView: 'month' }).miniView, 'month', '合法浮窗样式保留')
  eq(main.normalizeState({ miniWidth: 380, miniHeight: 500 }).miniHeight, 460, '旧标准档 380×500 迁移到 380×460')
  eq(main.normalizeState({ miniWidth: '400', miniHeight: 200 }).miniWidth, 380, '字符串浮窗宽度回落默认')
  eq(main.normalizeState({ miniWidth: 100, miniHeight: 5000 }).miniWidth, 280, '浮窗宽度低于下限被夹紧')
  eq(main.normalizeState({ miniWidth: 100, miniHeight: 5000 }).miniHeight, 1000, '浮窗高度高于上限被夹紧')

  const statePath = join(userData, 'window-state.json')
  writeFileSync(statePath, JSON.stringify({ themeMode: 'neon', width: 'x', miniVisible: 'yes' }))
  const loaded = main.loadState()
  eq(loaded.themeMode, 'system', 'loadState 读到非法主题也用默认值')
  eq(loaded.width, 1180, 'loadState 读到非法宽度也用默认值')
  eq(loaded.miniVisible, true, 'loadState 读到非法布尔用默认值')
  writeFileSync(statePath, '{ this is not json')
  eq(main.loadState().width, 1180, '半截 JSON 回落到默认值')
  rmSync(statePath, { force: true })
  eq(main.loadState().autoStart, true, '文件不存在时用默认值')

  /* ---------------------- 3. IPC 入参校验 ---------------------- */

  console.log('IPC：渲染层传非法值不能崩主进程')
  const channels = [...state.handlers.keys()]
  ok(channels.length > 30, `注册了足够多的通道（${channels.length} 条）`)

  async function call(channel, ...args) {
    const fn = state.handlers.get(channel)
    if (!fn) return { threw: true, value: `通道未注册：${channel}` }
    try {
      return { threw: false, value: await fn({ sender: {} }, ...args) }
    } catch (err) {
      return { threw: true, value: err?.message ?? String(err) }
    }
  }

  // 本地通道：绝不允许抛出去，且统一返回 { ok:false, error }
  const localChannels = channels.filter(
    (c) =>
      !c.startsWith('sync:') &&
      !c.startsWith('window:') &&
      !c.startsWith('mini:') &&
      c !== 'app:open-main'
  )
  const garbage = [undefined, null, 0, -1, Number.NaN, '', '  ', {}, [], true, { id: null }]
  const unguarded = []
  for (const channel of localChannels) {
    for (const arg of garbage) {
      const res = await call(channel, arg, arg, arg, arg)
      if (res.threw) {
        unguarded.push(`${channel}(${JSON.stringify(arg) ?? 'undefined'}) → ${res.value}`)
      } else if (res.value && typeof res.value === 'object' && 'ok' in res.value) {
        if (res.value.ok === false && typeof res.value.error !== 'string') {
          unguarded.push(`${channel} → ok:false 但没有 error 文案`)
        }
      }
    }
  }
  eq(
    unguarded,
    [],
    `所有本地通道对垃圾入参都是结构化失败（${localChannels.length} 条通道 × ${garbage.length} 组参数）`
  )

  // 正常路径仍然工作
  let res = await call('calendars:create', '主进程测试')
  ok(res.value?.ok === true && res.value.data.calendars.length === 3, 'calendars:create 正常可用')
  const createdCal = res.value.data.created.id
  res = await call('cells:appendLine', createdCal, '2026-01-05', '一行任务')
  ok(res.value?.ok === true && res.value.data.text === '一行任务', 'cells:appendLine 正常可用')
  res = await call('cells:updateLine', createdCal, '2026-01-05', 'x', 'y')
  ok(res.value?.ok === false, 'cells:updateLine 传字符串行号 → ok:false')
  res = await call('events:create', null)
  ok(res.value?.ok === false, 'events:create 传 null → ok:false')
  res = await call('events:create', {})
  ok(res.value?.ok === false, 'events:create 传空对象 → ok:false')
  res = await call('notes:create', null)
  ok(res.value?.ok === false, 'notes:create 传 null → ok:false')
  res = await call('search:query', '')
  ok(res.value?.ok === false, 'search:query 空串 → ok:false')
  res = await call('snapshots:list')
  ok(Array.isArray(res.value), 'snapshots:list 返回数组（不包信封）')
  res = await call('snapshots:restore', 'ghost')
  ok(res.value?.ok === false, 'snapshots:restore 传不存在的 id → ok:false')
  res = await call('snapshots:clear')
  ok(typeof res.value === 'number', 'snapshots:clear 返回数字（不包信封）')
  res = await call('theme:set-mode', 'neon')
  eq(res.value, 'system', 'theme:set-mode 拒绝非法值并返回当前值')
  res = await call('theme:set-mode', 'dark')
  eq(res.value, 'dark', 'theme:set-mode 接受合法值')
  res = await call('settings:set-close-to-tray', false)
  eq(res.value, false, 'settings:set-close-to-tray 生效')
  res = await call('settings:set-auto-start', true)
  eq(res.value, true, 'settings:set-auto-start 生效')
  res = await call('settings:get')
  eq(res.value.closeToTray, false, 'settings:get 读回刚设的值')
  res = await call('mcp:info')
  eq(res.value, { port: null, url: null }, 'mcp:info 未启动时返回 null')
  res = await call('app:ping')
  ok(res.value?.ok === true, 'app:ping 正常')

  // 只读通道不该触发广播/推送（先让第二个实例把窗口建出来，广播才有接收方）
  state.appListeners.get('second-instance')[0]({}, [])
  ok(state.windows.length >= 1, '第二个实例会建出主窗口')
  state.sent.length = 0
  await call('calendars:list')
  eq(state.sent.filter((s) => s.channel === 'data:changed').length, 0, '只读通道不广播 data:changed')
  await call('calendars:create', '会广播')
  ok(state.sent.some((s) => s.channel === 'data:changed'), '写通道会广播 data:changed')

  /* ---------------------- 4. preload 与主进程对得上 ---------------------- */

  console.log('preload：invoke 的通道主进程都注册了')
  const preloadSrc = readFileSync(join(root, 'src/preload/index.ts'), 'utf-8')
  const invoked = new Set([...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))
  ok(invoked.size > 25, `preload 里 invoke 了 ${invoked.size} 个通道`)
  eq([...invoked].filter((c) => !state.handlers.has(c)), [], 'preload 用到的通道都有主进程 handler')
  eq(
    channels.filter((c) => !invoked.has(c)),
    [],
    '主进程注册的通道 preload 都能调到'
  )
  const onChannels = new Set([...preloadSrc.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]))
  ok(onChannels.has('data:changed'), 'preload 监听了 data:changed')

  /* ---------------------- 5. 单实例与退出 ---------------------- */

  console.log('单实例 / 退出流程')
  const secondInstance = state.appListeners.get('second-instance') ?? []
  eq(secondInstance.length, 1, '拿到锁时注册了 second-instance')
  let secondThrew = null
  try {
    secondInstance[0]({}, ['electron', 'index.mjs'])
  } catch (err) {
    secondThrew = err.message
  }
  eq(secondThrew, null, '第二个实例再次触发时不抛错')
  eq(state.quitCalled, false, '拿到锁的实例不会自己退出')
  ok(state.exitCode === null, '不会误调 app.exit')

  const willQuit = state.appListeners.get('will-quit') ?? []
  eq(willQuit.length, 1, '注册了 will-quit 兜底')
  willQuit[0]({ preventDefault: () => {} })
  eq(state.exitCode, 0, 'will-quit 里强制 exit(0)')
  let closed = false
  try {
    db.listCalendars()
  } catch {
    closed = true
  }
  ok(closed, '退出前把数据库关掉了（WAL 会做 checkpoint）')
} finally {
  try {
    const db = await import(pathToFileURL(join(gen, 'db.mjs')).href)
    db.closeDb()
  } catch {
    /* 已经关了 */
  }
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* Windows 上偶尔删不掉 */
  }
}

console.log(failures === 0 ? `\n全部通过 ✅（${checks} 项）` : `\n${failures} 项失败 ❌（共 ${checks} 项）`)
process.exit(failures === 0 ? 0 : 1)
