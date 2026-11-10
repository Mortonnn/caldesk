/**
 * 浮窗「1天 / 1周 / 1月 + 可调尺寸 + 月视图」独立回归（真实 Electron + CDP + MCP）。
 *
 *   node scripts/verify-mini-range.mjs                 # 全跑
 *   node scripts/verify-mini-range.mjs --only=range    # 只跑范围那组
 *   node scripts/verify-mini-range.mjs --only=size     # 只跑尺寸/持久化那组
 *   node scripts/verify-mini-range.mjs --only=month    # 只跑月视图那组
 *   node scripts/verify-mini-range.mjs --keep          # 失败排查时保留临时 user-data
 *
 * 为什么单独写一个脚本（而不是塞进 ui-desktop.mjs 的 gMini）：
 *  - 这次改动跨「主进程状态 / 设置面板 / 浮窗渲染 / 窗口持久化」四层，
 *    任何一层漏接线都只在运行期暴露；独立脚本能同时连 index.html 和 mini.html 两个 CDP target，
 *    用同一份库对账，不会被主窗口月历的点击路径干扰。
 *  - 数据一律通过实例自己的 MCP 端点写入（items_set），不直接碰 SQLite。
 *
 * 隔离：--user-data 指向临时目录、CALDESK_MCP_PORT 用随机端口、CDP 端口也随机，
 * 绝不碰真实数据目录，也不抢正常实例的端口。默认结束后删临时目录。
 *
 * 退出码：0 全过 / 1 有失败。
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SHOT_DIR = join(ROOT, 'notes', 'test-reports', 'shots-mini-range')

const argv = process.argv.slice(2)
const argOf = (name, dflt = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  return argv.includes(`--${name}`) ? true : dflt
}
const ONLY = argOf('only')
const WANT_SHOTS = Boolean(argOf('shots', false))
const KEEP = Boolean(argOf('keep', false))

/* ------------------------------- 断言与计数 ------------------------------- */
let pass = 0
const fails = []
let groupName = ''
const ok = (m) => {
  pass += 1
  console.log(`  ✔ ${m}`)
}
const bad = (m, detail) => {
  fails.push(`${groupName} / ${m}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✘ ${m}${detail ? `\n      ${detail}` : ''}`)
}
const check = (cond, m, detail) => (cond ? ok(m) : bad(m, detail))
const eq = (actual, expected, m) =>
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    m,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
  )
const near = (actual, expected, tolerance, m) =>
  check(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    m,
    `期望 ${expected}±${tolerance}，实际 ${actual}`
  )
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const md = (d) => `${d.getMonth() + 1}月${d.getDate()}日`

function addDays(base, n) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  d.setDate(d.getDate() + n)
  return d
}

/** date-fns addMonths 的语义：目标月天数不够时夹到当月最后一天（1/31 + 1 月 = 2/28） */
function addMonths(base, n) {
  const d = new Date(base.getFullYear(), base.getMonth() + n, 1)
  const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(base.getDate(), days))
  return d
}

/** 含两端的自然日天数 */
function daysInclusive(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((b - a) / 86_400_000) + 1
}

/* ------------------------------ 月视图日期工具 ------------------------------ */
/** 周一为一周开始：返回本周周一（本地时间，不带时分秒） */
function startOfWeekMonday(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - dow)
  return x
}
function endOfWeekSunday(d) {
  const x = startOfWeekMonday(d)
  x.setDate(x.getDate() + 6)
  return x
}
/** 月视图的整月网格范围：本月 1 号所在周的周一 → 本月最后一天所在周的周日 */
function monthGridRange(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
  return { from: startOfWeekMonday(first), to: endOfWeekSunday(last) }
}
/** 月视图标题：yyyy年M月 */
function monthTitle(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

/* --------------------------------- CDP --------------------------------- */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.console = []
    this.exceptions = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { ok: good, bad: fail } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? fail(new Error(`${m.error.message} ${m.error.data ?? ''}`)) : good(m.result)
        return
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
          .join(' ')
        this.console.push({ type: m.params.type, text })
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        this.exceptions.push(d.exception?.description ?? d.text ?? 'unknown exception')
      } else if (m.method === 'Log.entryAdded') {
        this.console.push({ type: m.params.entry.level, text: m.params.entry.text })
      }
    })
  }
  send(method, params = {}) {
    const id = (this.id += 1)
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((good, fail) => this.pending.set(id, { ok: good, bad: fail }))
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result.value
  }
  async evalSoft(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description }
    return r.result.value
  }
  async shot(name) {
    if (!WANT_SHOTS) return
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(SHOT_DIR, { recursive: true })
    writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'))
  }
  /**
   * 直接把值灌进受控输入框。
   * React 会拦截 value 的 setter，必须用原型上的原生 setter 再补一个 input 事件，
   * 否则 onChange 不触发、状态还是旧的。
   */
  async fill(selector, text, index = 0) {
    await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
      if (!el) return false
      el.focus()
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(80)
  }
  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 }
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
    await sleep(80)
  }
  async box(selector, index = 0) {
    return this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
    })()`)
  }
  async click(selector, index = 0) {
    const b = await this.box(selector, index)
    if (!b || b.w <= 0 || b.h <= 0) throw new Error(`点不到 ${selector}[${index}]`)
    await this.clickAt(b.x, b.y)
    return b
  }
  /** 控制台里真正需要关注的：error/warning + 未捕获异常（过滤 Electron/DevTools 自带噪音） */
  issues() {
    const benign = [/Electron Security Warning/i, /React DevTools/i, /Download the React DevTools/i]
    const rows = [
      ...this.console.filter((c) => c.type === 'error' || c.type === 'warning'),
      ...this.exceptions.map((t) => ({ type: 'exception', text: String(t) }))
    ]
    return rows.filter((e) => !benign.some((re) => re.test(e.text)))
  }
  clearLog() {
    this.console.length = 0
    this.exceptions.length = 0
  }
}

/* ------------------------------ 启动 / 收尾 ------------------------------ */
let child = null
let userDataDir = null
let apiPort = null
let cdpPort = null
let childLog = ''
const allCdps = []

async function launch({ reuseUserData = false } = {}) {
  if (!existsSync(ELECTRON)) throw new Error('没找到 electron，先 npm i')
  const port = await freePort()
  apiPort = await freePort()
  if (!reuseUserData || !userDataDir) {
    userDataDir = join(
      tmpdir(),
      `caldesk-mini-range-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    )
  }
  const env = { ...process.env }
  // 本机默认开着 ELECTRON_RUN_AS_NODE，不清掉的话 Electron 会以纯 Node 跑起来
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.CALDESK_MCP_PORT = String(apiPort)
  childLog = ''
  child = spawn(
    ELECTRON,
    ['.', '--user-data', userDataDir, `--remote-debugging-port=${port}`, '--no-sandbox'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  child.stdout.on('data', (d) => (childLog += d.toString()))
  child.stderr.on('data', (d) => (childLog += d.toString()))

  let endpoint = port
  let target = null
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(childLog)
    if (m) endpoint = Number(m[1])
    try {
      const list = await (await fetch(`http://127.0.0.1:${endpoint}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (target?.webSocketDebuggerUrl) break
    } catch {
      /* 等 */
    }
    await sleep(250)
  }
  if (!target) throw new Error(`CDP 没等到主窗口（index.html）\n${childLog.slice(-2500)}`)
  cdpPort = endpoint

  const main = await connect(target)
  for (let i = 0; i < 120; i += 1) {
    const st = await main
      .eval(`({ grids: document.querySelectorAll('.grid').length, cals: document.querySelectorAll('.cal-item').length })`)
      .catch(() => ({ grids: 0, cals: 0 }))
    if (st.grids === 1 && st.cals > 0) break
    await sleep(150)
  }
  await sleep(300)
  main.logText = () => childLog
  return main
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const c = new Cdp(ws)
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await c.send('Log.enable')
  allCdps.push(c)
  return c
}

async function listTargets() {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  return list.filter((t) => t.type === 'page')
}

/** 等某个 CDP target 出现并连上（浮窗可能比主窗口晚几百毫秒创建） */
async function attach(match, { timeout = 20_000, ready = null } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const t = (await listTargets().catch(() => [])).find(match)
    if (t?.webSocketDebuggerUrl) {
      const c = await connect(t)
      if (ready) {
        const hit = await waitFor(c, ready, { timeout: 8000 })
        if (!hit) throw new Error(`连上了 target，但等不到就绪条件：${ready}`)
      } else {
        await sleep(500)
      }
      return c
    }
    await sleep(250)
  }
  throw new Error('CDP 里等不到目标页面')
}

function killTree() {
  if (!child) return
  const pid = child.pid
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  child = null
  // Electron 的 GPU/renderer 子进程会被 reparent，按 --user-data 路径再兜底扫一遍
  try {
    if (userDataDir) {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${userDataDir.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 15_000 })
    }
  } catch {
    /* 扫不到就算了 */
  }
}

function cleanup() {
  killTree()
  if (!KEEP && userDataDir && existsSync(userDataDir)) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 被占用就算了 */
    }
  }
}

/* ------------------------------ MCP / 页面辅助 ------------------------------ */
async function mcp(tool, args = {}) {
  const res = await fetch(`http://127.0.0.1:${apiPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args }
    })
  })
  const json = await res.json()
  if (json.error) throw new Error(`${tool}: ${json.error.message}`)
  const content = json.result?.content
  if (Array.isArray(content)) {
    try {
      return JSON.parse(content[0]?.text ?? 'null')
    } catch {
      return content[0]?.text ?? null
    }
  }
  return json.result
}

async function waitCalendars({ timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    try {
      const cals = await mcp('calendar_list')
      if (Array.isArray(cals) && cals.length > 0) return cals
      last = cals
    } catch (err) {
      last = String(err)
    }
    await sleep(250)
  }
  throw new Error(`MCP 没就绪（calendar_list 返回 ${JSON.stringify(last)}）`)
}

async function waitFor(cdp, expr, { timeout = 5000, every = 100 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await cdp.evalSoft(expr)
    if (v && !v.__error) return v
    await sleep(every)
  }
  return null
}

const RANGE_SEG = '.seg-group.mini-range-seg'
const SIZE_SEG = '.seg-group.mini-size-seg'
const VIEW_SEG = '.seg-group.mini-view-seg'
const MONTH_NAV = '.mini-month-nav'

async function openSettings(main) {
  const already = await main.eval(`!!document.querySelector('.panel .set-body')`)
  if (!already) {
    await main.click('[aria-label="设置"]')
    const okOpen = await waitFor(main, `!!document.querySelector('.panel .set-body')`, {
      timeout: 6000
    })
    if (!okOpen) throw new Error('设置面板没打开')
  }
  // 等 refreshSettings 把主进程真值灌进面板
  await waitFor(main, `document.querySelectorAll(${JSON.stringify(RANGE_SEG)} + ' .seg-item').length === 3`, {
    timeout: 4000
  }).catch(() => null)
  await sleep(250)
}

async function closeSettings(main) {
  const has = await main.eval(`!!document.querySelector('.panel')`)
  if (!has) return
  await main.eval(`(() => { document.querySelector('.panel-head .ghost:last-child')?.click(); return true })()`)
  await sleep(350)
}

async function readSeg(main, selector) {
  return main.eval(`(() => {
    const g = document.querySelector(${JSON.stringify(selector)})
    if (!g) return null
    const items = [...g.querySelectorAll('.seg-item')].map((b) => ({
      text: (b.textContent || '').trim(),
      on: b.classList.contains('on'),
      title: b.getAttribute('title') || ''
    }))
    return { count: items.length, items, labels: items.map((i) => i.text), active: items.filter((i) => i.on).map((i) => i.text) }
  })()`)
}

async function clickSeg(main, selector, label) {
  const pos = await main.eval(`(() => {
    const g = document.querySelector(${JSON.stringify(selector)})
    if (!g) return null
    const el = [...g.querySelectorAll('.seg-item')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })()`)
  if (!pos || pos.w <= 0 || pos.h <= 0) throw new Error(`设置面板里点不到分段项「${label}」`)
  await main.clickAt(pos.x, pos.y)
  await sleep(200)
}

/** 在浮窗里按容器 + 按钮文案点击（月视图的 ‹ / 今天 / › 导航） */
async function clickMiniButton(mini, containerSel, text) {
  const pos = await mini.eval(`(() => {
    const g = document.querySelector(${JSON.stringify(containerSel)})
    if (!g) return null
    const el = [...g.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })()`)
  if (!pos || pos.w <= 0 || pos.h <= 0) throw new Error(`浮窗里点不到「${text}」按钮`)
  await mini.clickAt(pos.x, pos.y)
  await sleep(250)
}

/* --------------------------- 浮窗分辨率（自定义尺寸） --------------------------- */
const RES_ROW = '.mini-res-row'

/** 读「浮窗分辨率」行：输入框值、aria、应用按钮态 */
async function readRes(main) {
  return main.eval(`(() => {
    const row = document.querySelector(${JSON.stringify(RES_ROW)})
    const inputs = [...document.querySelectorAll('.mini-res-input')]
    const apply = document.querySelector('.mini-res-apply')
    return {
      hasRow: !!row,
      hasControl: !!document.querySelector('.mini-res-control'),
      count: inputs.length,
      width: inputs[0]?.value ?? '',
      height: inputs[1]?.value ?? '',
      aria: inputs.map((i) => i.getAttribute('aria-label') || ''),
      x: (document.querySelector('.mini-res-x')?.textContent || '').trim(),
      applyText: (apply?.textContent || '').trim(),
      applyDisabled: !!apply?.disabled
    }
  })()`)
}

/** 往两个分辨率输入框里填值（走 React 原生 setter，否则 onChange 不触发） */
async function setRes(main, width, height) {
  await main.fill('.mini-res-input', String(width), 0)
  await main.fill('.mini-res-input', String(height), 1)
  await sleep(120)
}

async function clickResApply(main) {
  const b = await main.box('.mini-res-apply')
  if (!b || b.w <= 0) throw new Error('点不到分辨率「应用」按钮')
  await main.clickAt(b.x, b.y)
  await sleep(250)
}

/** 真拖拽右下角 .mini-resize-grip：CDP 鼠标事件 → pointer 事件 → 主进程 setSize */
async function dragGrip(mini, dx, dy) {
  const b = await mini.box('.mini-resize-grip')
  if (!b) throw new Error('找不到 .mini-resize-grip')
  await mini.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: b.x,
    y: b.y,
    button: 'left',
    buttons: 0
  })
  await mini.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: b.x,
    y: b.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await sleep(100)
  for (let i = 1; i <= 8; i += 1) {
    await mini.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: b.x + (dx * i) / 8,
      y: b.y + (dy * i) / 8,
      button: 'left',
      buttons: 1
    })
    await sleep(60)
  }
  await mini.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: b.x + dx,
    y: b.y + dy,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await sleep(600)
}

const MINI_SNAP = `(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const dayEls = qa('.mini-day')
  return {
    title: q('.mini-title strong')?.textContent?.trim() ?? '',
    sub: q('.mini-sub')?.textContent?.trim() ?? '',
    dayCount: dayEls.length,
    dayHeads: qa('.mini-day-head').length,
    weekCount: qa('.mini-week').length,
    weekHeads: qa('.mini-week-head').map((el) => (el.textContent || '').trim()),
    days: dayEls.map((el) => ({
      date: el.getAttribute('data-date') || '',
      hasHead: !!el.querySelector(':scope > .mini-day-head'),
      head: (el.querySelector('.mini-day-head')?.textContent || '').trim(),
      dateText: (el.querySelector('.mini-day-date')?.textContent || '').trim(),
      today: !!el.querySelector('.mini-day-today'),
      count: (el.querySelector('.mini-day-count')?.textContent || '').trim(),
      none: (el.querySelector('.mini-day-none')?.textContent || '').trim()
    })),
    weeks: qa('.mini-week').map((el) => ({
      hasHead: !!el.querySelector(':scope > .mini-week-head'),
      head: (el.querySelector('.mini-week-head')?.textContent || '').trim(),
      days: el.querySelectorAll('.mini-day').length
    })),
    todayBadges: qa('.mini-day-today').length,
    dayCountBadges: qa('.mini-day-count').length,
    noPlans: qa('.mini-day-none').length,
    rows: qa('.mini-task-row').map((el) => ({
      text: (el.querySelector('.mini-task-text')?.textContent || '').trim(),
      date: el.getAttribute('data-date') || el.closest('.mini-day')?.getAttribute('data-date') || ''
    })),
    texts: qa('.mini-task-text').map((el) => (el.textContent || '').trim()),
    grip: !!q('.mini-resize-grip'),
    innerW: innerWidth,
    innerH: innerHeight,
    bodyScrollW: document.body.scrollWidth,
    bodyScrollH: document.body.scrollHeight,
    bodyText: document.body.innerText
  }
})()`

const miniSnap = (mini) => mini.eval(MINI_SNAP)

/** 月视图快照：格子/周表头/导航/标题 + 溢出检查所需尺寸 */
const MINI_MONTH_SNAP = `(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const cells = qa('.mini-month-cell').map((el) => ({
    date: el.getAttribute('data-date') || '',
    daynum: (el.querySelector('.mini-month-daynum')?.textContent || '').trim(),
    outside: el.classList.contains('outside'),
    today: el.classList.contains('today') || !!el.querySelector('.mini-month-today'),
    lines: [...el.querySelectorAll('.mini-month-line')].map((x) => ({
      text: (x.textContent || '').trim(),
      event: x.classList.contains('event'),
      task: x.classList.contains('task'),
      done: x.classList.contains('done')
    })),
    more: (el.querySelector('.mini-month-more')?.textContent || '').trim(),
    text: (el.textContent || '').trim()
  }))
  const firstCell = qa('.mini-month-cell')[0]
  const firstRect = firstCell?.getBoundingClientRect()
  return {
    hasGrid: !!q('.mini-month-grid'),
    cellCount: cells.length,
    cells,
    cellW: firstRect ? Math.round(firstRect.width) : 0,
    cellH: firstRect ? Math.round(firstRect.height) : 0,
    weekdays: qa('.mini-month-weekday').map((el) => (el.textContent || '').trim()),
    title: q('.mini-title strong')?.textContent?.trim() ?? '',
    sub: q('.mini-sub')?.textContent?.trim() ?? '',
    dayCount: qa('.mini-day').length,
    weekCount: qa('.mini-week').length,
    dayHeadCount: qa('.mini-day-head').length,
    weekHeadCount: qa('.mini-week-head').length,
    navTexts: qa('.mini-month-nav button').map((b) => (b.textContent || '').trim()),
    innerW: innerWidth,
    innerH: innerHeight,
    bodyScrollW: document.body.scrollWidth,
    bodyScrollH: document.body.scrollHeight,
    bodyText: document.body.innerText
  }
})()`
const miniMonthSnap = (mini) => mini.eval(MINI_MONTH_SNAP)

async function waitMiniDays(mini, n, timeout = 8000) {
  return waitFor(mini, `document.querySelectorAll('.mini-day').length === ${n}`, { timeout })
}

function waitStateFile(pred, { timeout = 6000 } = {}) {
  const p = join(userDataDir, 'window-state.json')
  const deadline = Date.now() + timeout
  return (async () => {
    while (Date.now() < deadline) {
      if (existsSync(p)) {
        try {
          const raw = readFileSync(p, 'utf-8')
          const state = JSON.parse(raw)
          if (pred(state)) return state
        } catch {
          /* 半截写入，下一轮再读 */
        }
      }
      await sleep(120)
    }
    return null
  })()
}

/* --------------------------------- 各组 --------------------------------- */
async function findMainAndMini() {
  const targets = await listTargets()
  const urls = targets.map((t) => t.url)
  check(
    targets.some((t) => /index\.html/.test(t.url)) && targets.some((t) => /mini\.html/.test(t.url)),
    'CDP 里同时有 index.html 与 mini.html 两个页面',
    urls.join(' | ')
  )
}

async function testRange(main, mini, today, d1, d8, calId) {
  groupName = 'range 范围切换'
  console.log('\n== range 1天/1周/1月 ==')

  await openSettings(main)

  // ---- 设置面板的分段控件本身 ----
  const rangeSeg = await readSeg(main, RANGE_SEG)
  check(Boolean(rangeSeg), `设置面板有范围分段组 ${RANGE_SEG}`)
  eq(rangeSeg?.labels, ['1天', '1周', '1月'], '范围分段项文案 = 1天/1周/1月')
  eq(rangeSeg?.active, ['1月'], '新安装默认高亮 1月')
  // 下面仍按原列表模式断言走：先把范围切回 1天
  await clickSeg(main, RANGE_SEG, '1天')
  await sleep(700)

  const sizeSeg = await readSeg(main, SIZE_SEG)
  check(Boolean(sizeSeg), `设置面板有尺寸分段组 ${SIZE_SEG}`)
  eq(sizeSeg?.labels, ['小', '标准', '大'], '尺寸分段项文案 = 小/标准/大')
  eq(
    sizeSeg?.items?.map((i) => i.title),
    ['320 × 420', '380 × 460', '480 × 550'],
    '尺寸分段项 title 是各档宽高'
  )

  // ---- 默认 1天 ----
  const snapDay0 = await miniSnap(mini)
  eq(snapDay0.title, md(today), '默认 1天：标题 = 今天')
  check(/星期/.test(snapDay0.sub), `默认 1天：副标题是星期（${snapDay0.sub}）`)
  check(snapDay0.texts.includes('MR今天'), '默认 1天：显示今天的任务', snapDay0.texts.join(' | '))
  check(!snapDay0.texts.includes('MR明天'), '默认 1天：不显示今天+1 的任务', snapDay0.texts.join(' | '))
  check(!snapDay0.texts.includes('MR今天8'), '默认 1天：不显示今天+8 的任务', snapDay0.texts.join(' | '))
  eq(snapDay0.dayCount, 0, '默认 1天：没有多天分组容器')
  eq(snapDay0.weekCount, 0, '默认 1天：没有周分组容器')
  check(snapDay0.grip, '浮窗有 .mini-resize-grip 缩放手柄')
  await mini.shot('01-mini-day')

  // ---- 切 1周 ----
  await clickSeg(main, RANGE_SEG, '1周')
  const gotWeek = await waitMiniDays(mini, 8)
  check(Boolean(gotWeek), '切 1周后浮窗渲染出 8 个 .mini-day', `实际 ${await mini.eval(`document.querySelectorAll('.mini-day').length`)}`)
  const snapWeek = await miniSnap(mini)
  eq(snapWeek.dayCount, 8, '1周：day section = 8')
  eq(snapWeek.dayHeads, 8, '1周：day-head = 8（每天一个分隔头）')
  eq(snapWeek.weekCount, 2, '1周：week section = 2')
  eq(snapWeek.weekHeads.length, 2, '1周：week-head = 2')
  eq(snapWeek.todayBadges, 1, '1周：只有一个「今天」徽标')
  eq(snapWeek.days[0]?.date, ymd(today), '1周：第一个 day 的 data-date = 今天')
  eq(snapWeek.days[7]?.date, ymd(addDays(today, 7)), '1周：最后一个 day 的 data-date = 今天+7')
  check(snapWeek.days.every((d) => d.hasHead), '1周：每个 .mini-day 的第一个子元素都是 .mini-day-head')
  check(snapWeek.weeks.every((w) => w.hasHead), '1周：每个 .mini-week 的第一个子元素都是 .mini-week-head')
  check(/本周/.test(snapWeek.weekHeads[0] ?? ''), `1周：第一周标题含「本周」（${snapWeek.weekHeads[0]}）`)
  check(/下周/.test(snapWeek.weekHeads[1] ?? ''), `1周：第二周标题含「下周」（${snapWeek.weekHeads[1]}）`)
  check(snapWeek.rows.some((r) => r.text === 'MR今天' && r.date === ymd(today)), '1周：今天任务落在今天的 day 里', JSON.stringify(snapWeek.rows))
  check(snapWeek.rows.some((r) => r.text === 'MR明天' && r.date === ymd(d1)), '1周：今天+1 的任务出现且日期正确', JSON.stringify(snapWeek.rows))
  check(!snapWeek.texts.includes('MR今天8'), '1周：今天+8 的任务不出现', snapWeek.texts.join(' | '))
  eq(snapWeek.title, `${md(today)} – ${md(addDays(today, 7))}`, '1周：标题 = 今天 – 今天+7')
  // .mini-sub 里还会塞「N 项待办」药丸，所以只比前缀，不整串相等
  check(
    String(snapWeek.sub ?? '').startsWith('接下来 8 天'),
    `1周：副标题以「接下来 8 天」开头（${snapWeek.sub}）`
  )
  const weekEmpty = snapWeek.days.filter((d) => d.none === '无安排').length
  eq(weekEmpty, 8 - 2, '1周：6 个空白天显示「无安排」')
  eq(snapWeek.noPlans, 6, '1周：.mini-day-none 数量 = 空白天数')
  eq(snapWeek.dayCountBadges, 2, '1周：有任务的 day 才显示条数徽标')
  check(snapWeek.bodyScrollW <= snapWeek.innerW + 1, `1周：没有横向溢出（${snapWeek.bodyScrollW} ≤ ${snapWeek.innerW}）`)
  const weekSegAfter = await readSeg(main, RANGE_SEG)
  eq(weekSegAfter?.active, ['1周'], '切 1周后设置面板高亮跟随')
  await mini.shot('02-mini-week')

  // ---- 切 1月 ----
  const monthEnd = addMonths(today, 1)
  const expectedDays = daysInclusive(today, monthEnd)
  await clickSeg(main, RANGE_SEG, '1月')
  const gotMonth = await waitMiniDays(mini, expectedDays)
  check(
    Boolean(gotMonth),
    `切 1月后浮窗渲染出 ${expectedDays} 个 .mini-day`,
    `实际 ${await mini.eval(`document.querySelectorAll('.mini-day').length`)}`
  )
  const snapMonth = await miniSnap(mini)
  eq(snapMonth.dayCount, expectedDays, `1月：day section = ${expectedDays}（今天…下月同日含两端）`)
  eq(snapMonth.dayHeads, expectedDays, `1月：day-head = ${expectedDays}`)
  check(snapMonth.weekCount >= 4, `1月：week section >= 4（实际 ${snapMonth.weekCount}）`)
  eq(snapMonth.weekHeads.length, snapMonth.weekCount, '1月：每个 week 都有 week-head')
  const expectedWeekLabels = Array.from({ length: snapMonth.weekCount }, (_, i) =>
    i === 0 ? '本周' : `${'下'.repeat(i)}周`
  )
  eq(snapMonth.weekHeads, expectedWeekLabels, '1月：周标题全部是 本周/下周/下下周…')
  const stickyScroll = await mini.eval(`(() => {
    const list = document.querySelector('.mini-list')
    const heads = [...document.querySelectorAll('.mini-week-head')]
    if (!list || heads.length < 2) return null
    const listTop = list.getBoundingClientRect().top
    list.scrollTop += heads[1].getBoundingClientRect().top - listTop + 30
    return list.scrollTop
  })()`)
  await sleep(250)
  const sticky = await mini.eval(`(() => {
    const list = document.querySelector('.mini-list')
    const heads = [...document.querySelectorAll('.mini-week-head')]
    const listTop = list.getBoundingClientRect().top
    return {
      scrollTop: list.scrollTop,
      listTop: Math.round(listTop),
      heads: heads.map((h) => Math.round(h.getBoundingClientRect().top))
    }
  })()`)
  check(Boolean(stickyScroll !== null && sticky?.heads?.length >= 2), '1月：有可滚动的周分组')
  check(
    sticky && Math.abs(sticky.heads[1] - sticky.listTop) <= 2,
    `1月：滚到下一周后「下周」吸顶（${sticky?.heads?.[1]} vs ${sticky?.listTop}）`
  )
  check(
    sticky && sticky.heads[0] < sticky.listTop - 2,
    `1月：滚过本周后「本周」标题被顶走（${sticky?.heads?.[0]} < ${sticky?.listTop}）`
  )
  await mini.shot('03b-mini-sticky-week')
  eq(snapMonth.days[0]?.date, ymd(today), '1月：第一个 day = 今天')
  eq(snapMonth.days[snapMonth.days.length - 1]?.date, ymd(monthEnd), '1月：最后一个 day = 下月同日')
  check(snapMonth.rows.some((r) => r.text === 'MR今天8' && r.date === ymd(d8)), '1月：今天+8 的任务出现且日期正确', JSON.stringify(snapMonth.rows))
  check(snapMonth.todayBadges === 1, '1月：只有一个「今天」徽标')
  eq(snapMonth.title, `${md(today)} – ${md(monthEnd)}`, '1月：标题 = 今天 – 下月同日')
  check(
    String(snapMonth.sub ?? '').startsWith('今天起 1 个月'),
    `1月：副标题以「今天起 1 个月」开头（${snapMonth.sub}）`
  )
  eq(snapMonth.noPlans, expectedDays - 3, `1月：空白天数 = ${expectedDays} - 3`)
  check(snapMonth.bodyScrollW <= snapMonth.innerW + 1, `1月：没有横向溢出（${snapMonth.bodyScrollW} ≤ ${snapMonth.innerW}）`)
  const monthSegAfter = await readSeg(main, RANGE_SEG)
  eq(monthSegAfter?.active, ['1月'], '切 1月后设置面板高亮跟随')
  await mini.shot('03-mini-month')

  // ---- 切回 1天 ----
  await clickSeg(main, RANGE_SEG, '1天')
  const back = await waitFor(mini, `document.querySelectorAll('.mini-day').length === 0`, {
    timeout: 6000
  })
  check(Boolean(back), '切回 1天：多天分组容器消失')
  const snapBack = await miniSnap(mini)
  eq(snapBack.title, md(today), '切回 1天：标题 = 今天')
  eq(snapBack.dayCount, 0, '切回 1天：day section = 0')
  eq(snapBack.weekCount, 0, '切回 1天：week section = 0')
  check(snapBack.texts.includes('MR今天'), '切回 1天：今天任务还在')
  check(!snapBack.texts.includes('MR明天') && !snapBack.texts.includes('MR今天8'), '切回 1天：+1 / +8 任务不显示', snapBack.texts.join(' | '))
  const backSeg = await readSeg(main, RANGE_SEG)
  eq(backSeg?.active, ['1天'], '切回 1天后设置面板高亮 = 1天')
  await mini.shot('04-mini-day-again')

  // 数据在 MCP 侧确实写进去了（界面断言不能代替库断言）
  const cell0 = await mcp('items_get', { calendar_id: calId, date: ymd(today) })
  check((cell0?.lines ?? []).includes('MR今天'), 'MCP 对账：今天的数据在库里')
  return { monthEnd, expectedDays }
}

async function testSize(main, mini, today) {
  groupName = 'size 尺寸与持久化'
  console.log('\n== size 浮窗尺寸 / window-state.json / 重启 ==')

  await openSettings(main)

  // ---- 默认 380×460，标准档高亮，分辨率输入框跟随 ----
  const before = await miniSnap(mini)
  near(before.innerW, 380, 2, `默认浮窗宽度 ≈ 380（实际 ${before.innerW}）`)
  near(before.innerH, 460, 2, `默认浮窗高度 ≈ 460（实际 ${before.innerH}）`)
  const sizeBefore = await readSeg(main, SIZE_SEG)
  eq(sizeBefore?.active, ['标准'], '默认尺寸高亮「标准」')
  eq(sizeBefore?.labels, ['小', '标准', '大'], '默认浮窗大小只有 3 个预设（无自定义）')

  const res0 = await readRes(main)
  check(res0.hasRow && res0.hasControl, '设置面板有「浮窗分辨率」行（.mini-res-row / .mini-res-control）')
  eq([res0.width, res0.height], ['380', '460'], '默认分辨率输入框显示 380 × 460')
  eq(res0.count, 2, '分辨率行有宽度/高度两个输入框')
  eq(res0.aria, ['浮窗宽度', '浮窗高度'], '分辨率输入框 aria-label = 浮窗宽度/浮窗高度')
  eq(res0.x, '×', '两个输入框之间是 ×')
  eq(res0.applyText, '应用', '分辨率行有「应用」按钮')
  eq(res0.applyDisabled, false, '默认分辨率合法时「应用」可用')

  // ---- 点「小」/「大」：输入框必须自动跟随 ----
  await clickSeg(main, SIZE_SEG, '小')
  const smallPreset = await waitFor(
    mini,
    `Math.abs(innerWidth - 320) <= 2 && Math.abs(innerHeight - 420) <= 2`,
    { timeout: 8000 }
  )
  check(Boolean(smallPreset), '点「小」后浮窗实际变成 320×420')
  const resSmall = await readRes(main)
  eq([resSmall.width, resSmall.height], ['320', '420'], '点「小」后分辨率输入框自动变 320 × 420')
  eq((await readSeg(main, SIZE_SEG))?.active, ['小'], '点「小」后设置面板高亮「小」')

  await clickSeg(main, SIZE_SEG, '大')
  const resized = await waitFor(
    mini,
    `Math.abs(innerWidth - 480) <= 2 && Math.abs(innerHeight - 550) <= 2`,
    { timeout: 8000 }
  )
  check(Boolean(resized), '点「大」后浮窗实际尺寸变成 480×550', `实际 ${await mini.eval(`innerWidth + '×' + innerHeight`)}`)
  const after = await miniSnap(mini)
  near(after.innerW, 480, 2, '点「大」后 innerWidth ≈ 480')
  near(after.innerH, 550, 2, '点「大」后 innerHeight ≈ 550')
  check(after.bodyScrollW <= after.innerW + 1, `放大后没有横向溢出（${after.bodyScrollW} ≤ ${after.innerW}）`)
  const sizeAfter = await readSeg(main, SIZE_SEG)
  eq(sizeAfter?.active, ['大'], '点「大」后设置面板高亮「大」')
  const resBig = await readRes(main)
  eq([resBig.width, resBig.height], ['480', '550'], '点「大」后分辨率输入框自动变 480 × 550')

  // ---- 手动输入 420×560：浮窗实际变化 + 自动多出「自定义」并高亮 ----
  await setRes(main, 420, 560)
  const typed = await readRes(main)
  eq([typed.width, typed.height], ['420', '560'], '手动输入后输入框保持 420 / 560')
  await clickResApply(main)
  const customOk = await waitFor(
    mini,
    `Math.abs(innerWidth - 420) <= 2 && Math.abs(innerHeight - 560) <= 2`,
    { timeout: 8000 }
  )
  check(Boolean(customOk), '手动 420×560 应用后浮窗实际变成 420×560', `实际 ${await mini.eval(`innerWidth + '×' + innerHeight`)}`)
  const resApplied = await readRes(main)
  eq([resApplied.width, resApplied.height], ['420', '560'], '应用后输入框保持 420 / 560')
  const customSeg = await readSeg(main, SIZE_SEG)
  eq(customSeg?.labels, ['小', '标准', '大', '自定义'], '自定义尺寸后浮窗大小从 3 项变 4 项（多出「自定义」）')
  eq(customSeg?.active, ['自定义'], '「自定义」自动高亮')
  eq(
    customSeg?.items?.find((i) => i.text === '自定义')?.title,
    '420 × 560',
    '「自定义」档 title = 420 × 560'
  )
  await mini.shot('05a-mini-custom')

  // ---- 非法值：应用按钮 disabled，尺寸不变 ----
  await setRes(main, 100, 100)
  eq((await readRes(main)).applyDisabled, true, '输入 100×100（低于下限）时「应用」按钮 disabled')
  await sleep(500)
  const stillCustom = await miniSnap(mini)
  near(stillCustom.innerW, 420, 2, '非法值不改变浮窗宽度')
  near(stillCustom.innerH, 560, 2, '非法值不改变浮窗高度')
  await setRes(main, '', '')
  eq((await readRes(main)).applyDisabled, true, '清空输入时「应用」按钮 disabled')

  // ---- 再点「标准」：输入框回 380×460，自定义档消失 ----
  await clickSeg(main, SIZE_SEG, '标准')
  const stdOk = await waitFor(
    mini,
    `Math.abs(innerWidth - 380) <= 2 && Math.abs(innerHeight - 460) <= 2`,
    { timeout: 8000 }
  )
  check(Boolean(stdOk), '点「标准」后浮窗回到 380×460')
  const resStd = await readRes(main)
  eq([resStd.width, resStd.height], ['380', '460'], '点「标准」后输入框自动回 380 / 460')
  const stdSeg = await readSeg(main, SIZE_SEG)
  eq(stdSeg?.labels, ['小', '标准', '大'], '点「标准」后浮窗大小恢复 3 项（无自定义）')
  eq(stdSeg?.active, ['标准'], '点「标准」后高亮「标准」')

  // ---- 拖 .mini-resize-grip 到非预设尺寸：同样应出现「自定义」并高亮 ----
  // 往左上拖 = 窗口缩小，右下角锚点不动、窗口坐标不变；CDP 合成的 screenX
  // 才是稳定基准（往右下拖时窗口会被主进程往左推，screenX 基准跟着变）。
  await dragGrip(mini, -10, -8)
  const dragged = await waitFor(
    mini,
    `Math.abs(innerWidth - 370) <= 3 && Math.abs(innerHeight - 452) <= 3`,
    { timeout: 6000 }
  )
  check(
    Boolean(dragged),
    '拖拽 .mini-resize-grip 后浮窗尺寸变成非预设（约 370×452）',
    `实际 ${await mini.eval(`innerWidth + '×' + innerHeight`)}`
  )
  // 等 250ms 防抖落盘 + settings:changed 广播到主窗口，输入框/自定义档才是终值
  await sleep(600)
  const draggedSnap = await miniSnap(mini)
  const dragSeg = await readSeg(main, SIZE_SEG)
  eq(dragSeg?.labels, ['小', '标准', '大', '自定义'], '拖拽到非预设尺寸后出现「自定义」')
  eq(dragSeg?.active, ['自定义'], '拖拽后「自定义」高亮')
  const resDrag = await readRes(main)
  eq(
    [resDrag.width, resDrag.height],
    [String(draggedSnap.innerW), String(draggedSnap.innerH)],
    '拖拽后分辨率输入框跟随实际尺寸'
  )
  await mini.shot('05b-mini-grip')

  // ---- 恢复「大」480×550，保证后面的 window-state / 重启断言不受影响 ----
  await clickSeg(main, SIZE_SEG, '大')
  const backBig = await waitFor(
    mini,
    `Math.abs(innerWidth - 480) <= 2 && Math.abs(innerHeight - 550) <= 2`,
    { timeout: 8000 }
  )
  check(Boolean(backBig), '最后恢复为「大」480×550')
  const resBackBig = await readRes(main)
  eq([resBackBig.width, resBackBig.height], ['480', '550'], '恢复「大」后输入框 480 / 550')
  eq((await readSeg(main, SIZE_SEG))?.active, ['大'], '恢复「大」后高亮「大」')

  // window-state.json 落盘（主进程 resized 事件防抖 250ms）
  const state = await waitStateFile((s) => s.miniWidth === 480 && s.miniHeight === 550)
  check(Boolean(state), 'window-state.json 写入 miniWidth=480 / miniHeight=550', state ? JSON.stringify(state) : '文件里没有这两个值')
  eq(state?.miniRange, 'day', 'window-state.json 的 miniRange = day（切回 1天 后落盘）')
  eq(typeof state?.miniWidth, 'number', 'window-state.json 的 miniWidth 是数字')
  eq(typeof state?.miniHeight, 'number', 'window-state.json 的 miniHeight 是数字')
  await mini.shot('05-mini-large')

  // 重启验证：同一 user-data 再起一个实例，尺寸应该还是 480×550
  console.log('  · 重启实例验证持久化…')
  killTree()
  await sleep(1200)
  const main2 = await launch({ reuseUserData: true })
  const mini2 = await attach((t) => /mini\.html/.test(t.url), { ready: `!!document.querySelector('.mini')` })
  const restarted = await miniSnap(mini2)
  near(restarted.innerW, 480, 2, `重启后浮窗宽度仍是 480（实际 ${restarted.innerW}）`)
  near(restarted.innerH, 550, 2, `重启后浮窗高度仍是 550（实际 ${restarted.innerH}）`)
  eq(restarted.title, md(today), '重启后仍是 1天模式（范围持久化）')

  const main2Ok = await waitFor(main2, `document.querySelectorAll('.cal-item').length > 0`, { timeout: 8000 })
  check(Boolean(main2Ok), '重启后主窗口正常加载')
  await openSettings(main2)
  const range2 = await readSeg(main2, RANGE_SEG)
  const size2 = await readSeg(main2, SIZE_SEG)
  eq(range2?.active, ['1天'], '重启后设置面板范围 = 1天')
  eq(size2?.active, ['大'], '重启后设置面板尺寸 = 大')
  const res2 = await readRes(main2)
  eq([res2.width, res2.height], ['480', '550'], '重启后分辨率输入框显示 480 / 550')
  const state2 = await waitStateFile((s) => s.miniWidth === 480 && s.miniHeight === 550)
  check(Boolean(state2), '重启后 window-state.json 仍是 480×550')
  await mini2.shot('06-mini-after-restart')
  return { main2, mini2 }
}

async function testMonthView(main, mini, today, d1, calId) {
  groupName = 'monthview 月视图'
  console.log('\n== monthview 月视图 ==')

  await openSettings(main)

  // 1) 默认仍是列表：显示样式分段 + 范围分段都在
  const viewSeg = await readSeg(main, VIEW_SEG)
  check(Boolean(viewSeg), `设置面板有显示样式分段组 ${VIEW_SEG}`)
  eq(viewSeg?.labels, ['列表', '月视图'], '显示样式分段项文案 = 列表/月视图')
  eq(viewSeg?.active, ['列表'], '默认高亮「列表」')
  const rangeSeg = await readSeg(main, RANGE_SEG)
  check(Boolean(rangeSeg), '列表模式下 .mini-range-seg 仍存在')

  // 2) 月视图专用数据：今天、今天+1 各一条任务 + 一条事件；今天+1 多一条任务触发 +N
  await mcp('items_set', { calendar_id: calId, date: ymd(d1), text: 'MR明天\nMR明天B' })
  await mcp('event_create', { title: 'MR事件今天', kind: 'task', start: ymd(today) })
  await mcp('event_create', { title: 'MR事件明天', kind: 'task', start: ymd(d1) })
  await sleep(1000)
  console.log('  · 月视图测试数据已写入（任务 + 事件）')

  // 3) 切月视图
  await clickSeg(main, VIEW_SEG, '月视图')
  const gotGrid = await waitFor(
    mini,
    `!!document.querySelector('.mini-month-grid') && document.querySelectorAll('.mini-month-cell').length >= 35`,
    { timeout: 8000 }
  )
  check(Boolean(gotGrid), '切「月视图」后出现 .mini-month-grid')
  const m = await miniMonthSnap(mini)
  check(m.hasGrid, '月视图：.mini-month-grid 存在')
  check([35, 42].includes(m.cellCount), `月视图：.mini-month-cell 数量为 35 或 42（实际 ${m.cellCount}）`)
  eq(m.cellCount % 7, 0, '月视图：格子数是 7 的倍数')
  eq(
    m.weekdays,
    ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    '月视图：周表头 7 项且周一起'
  )
  eq(m.title, monthTitle(today), '月视图：标题 = 当前年月的 yyyy年M月')
  check(String(m.sub ?? '').startsWith('月视图'), `月视图：副标题以「月视图」开头（${m.sub}）`)
  eq(m.dayCount, 0, '月视图：不再渲染 .mini-day 分组')
  eq(m.weekCount, 0, '月视图：不再渲染 .mini-week 分组')
  eq(m.dayHeadCount, 0, '月视图：不再渲染 .mini-day-head')
  eq(m.weekHeadCount, 0, '月视图：不再渲染 .mini-week-head')
  eq(m.navTexts, ['‹', '今天', '›'], '月视图：月份导航顺序 = ‹ / 今天 / ›')

  const cur = new Date(today.getFullYear(), today.getMonth(), 1)
  const r0 = monthGridRange(cur)
  eq(m.cells[0]?.date, ymd(r0.from), '月视图：首格 = 本月 1 号所在周的周一')
  eq(m.cells[m.cells.length - 1]?.date, ymd(r0.to), '月视图：末格 = 本月最后一天所在周的周日')
  check(m.cells.some((c) => c.outside), '月视图：非本月格子带 .outside')

  const todayCell = m.cells.find((c) => c.date === ymd(today))
  check(Boolean(todayCell), '月视图：找得到今天格子')
  check(todayCell?.today === true, '月视图：今天格子有 today 高亮')
  check(
    todayCell?.daynum?.includes(String(today.getDate())),
    `月视图：今天格显示日期数字（${todayCell?.daynum}）`
  )
  const todayText = (todayCell?.lines ?? []).map((l) => l.text).join(' | ')
  check(/MR今天|MR事件今天/.test(todayText), `月视图：今天格子显示任务/事件（${todayText}）`)
  check((todayCell?.lines ?? []).some((l) => l.event), '月视图：格内事件行带 .event')
  check((todayCell?.lines ?? []).some((l) => l.task), '月视图：格内任务行带 .task')
  check((todayCell?.lines ?? []).length <= 2, '月视图：每格最多显示 2 条')

  const d1Cell = m.cells.find((c) => c.date === ymd(d1))
  check(Boolean(d1Cell), '月视图：找得到今天+1 格子')
  const d1Text = (d1Cell?.lines ?? []).map((l) => l.text).join(' | ')
  check(/MR明天|MR事件明天/.test(d1Text), `月视图：今天+1 格子显示任务/事件（${d1Text}）`)
  check(/^\+\d+$/.test(d1Cell?.more ?? ''), `月视图：超出 2 条时显示 +N（${d1Cell?.more}）`)
  check(m.bodyScrollW <= m.innerW + 1, `月视图：当前宽度无横向溢出（${m.bodyScrollW} ≤ ${m.innerW}）`)
  const cellRatio = m.cellH > 0 ? m.cellW / m.cellH : 0
  check(
    cellRatio >= 0.75 && cellRatio <= 1.35,
    `月视图：日格接近正方形（${m.cellW}×${m.cellH}，比例 ${cellRatio.toFixed(2)}）`
  )
  await mini.shot('07-mini-month-view')

  // 4) 上一月 / 下一月 / 今天
  const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
  await clickMiniButton(mini, MONTH_NAV, '›')
  await waitFor(
    mini,
    `document.querySelector('.mini-title strong')?.textContent.trim() === ${JSON.stringify(monthTitle(next))}`,
    { timeout: 5000 }
  )
  const mNext = await miniMonthSnap(mini)
  eq(mNext.title, monthTitle(next), '点「›」后标题 = 下个月')
  const rNext = monthGridRange(next)
  eq(mNext.cells[0]?.date, ymd(rNext.from), '点「›」后网格首格日期变化')
  eq(mNext.cells[mNext.cells.length - 1]?.date, ymd(rNext.to), '点「›」后网格末格日期变化')

  const prev = new Date(cur.getFullYear(), cur.getMonth() - 1, 1)
  await clickMiniButton(mini, MONTH_NAV, '‹') // 回当前月
  await sleep(300)
  await clickMiniButton(mini, MONTH_NAV, '‹') // 再上一月
  await waitFor(
    mini,
    `document.querySelector('.mini-title strong')?.textContent.trim() === ${JSON.stringify(monthTitle(prev))}`,
    { timeout: 5000 }
  )
  const mPrev = await miniMonthSnap(mini)
  eq(mPrev.title, monthTitle(prev), '点两次「‹」后标题 = 上个月')
  const rPrev = monthGridRange(prev)
  eq(mPrev.cells[0]?.date, ymd(rPrev.from), '上个月网格首格日期正确')
  eq(mPrev.cells[mPrev.cells.length - 1]?.date, ymd(rPrev.to), '上个月网格末格日期正确')

  await clickMiniButton(mini, MONTH_NAV, '今天')
  await waitFor(
    mini,
    `document.querySelector('.mini-title strong')?.textContent.trim() === ${JSON.stringify(monthTitle(today))}`,
    { timeout: 5000 }
  )
  const mToday = await miniMonthSnap(mini)
  eq(mToday.title, monthTitle(today), '点「今天」回到当前月')
  eq(mToday.cells[0]?.date, ymd(r0.from), '点「今天」后网格首格回到当前月')

  // 6) 320×420 / 480×550 无横向溢出
  await clickSeg(main, SIZE_SEG, '小')
  const smallOk = await waitFor(
    mini,
    `Math.abs(innerWidth - 320) <= 2 && Math.abs(innerHeight - 420) <= 2`,
    { timeout: 12000 }
  )
  check(Boolean(smallOk), '月视图：切到 320×420 成功')
  const mSmall = await miniMonthSnap(mini)
  check(mSmall.bodyScrollW <= mSmall.innerW + 1, `月视图 320×420 无横向溢出（${mSmall.bodyScrollW} ≤ ${mSmall.innerW}）`)
  check(mSmall.bodyScrollH <= mSmall.innerH + 2, `月视图 320×420 无纵向溢出（${mSmall.bodyScrollH} ≤ ${mSmall.innerH}）`)
  const smallRatio = mSmall.cellH > 0 ? mSmall.cellW / mSmall.cellH : 0
  check(
    smallRatio >= 0.7 && smallRatio <= 1.4,
    `月视图 320×420 日格仍接近正方形（${mSmall.cellW}×${mSmall.cellH}，比例 ${smallRatio.toFixed(2)}）`
  )
  await mini.shot('08-mini-month-small')

  await clickSeg(main, SIZE_SEG, '大')
  const bigExpr = `Math.abs(innerWidth - 480) <= 2 && Math.abs(innerHeight - 550) <= 2`
  let bigOk = await waitFor(mini, bigExpr, { timeout: 12000 })
  // 小→大连点时 setBounds 偶发落在上一次 resize 防抖窗口里，补点一次即可
  if (!bigOk) {
    await clickSeg(main, SIZE_SEG, '大')
    bigOk = await waitFor(mini, bigExpr, { timeout: 12000 })
  }
  check(Boolean(bigOk), '月视图：切到 480×550 成功')
  const mBig = await miniMonthSnap(mini)
  check(mBig.bodyScrollW <= mBig.innerW + 1, `月视图 480×550 无横向溢出（${mBig.bodyScrollW} ≤ ${mBig.innerW}）`)
  await mini.shot('09-mini-month-large')

  // 7) 持久化：window-state.json 写 miniView=month，重启后仍高亮月视图
  const st = await waitStateFile((s) => s.miniView === 'month')
  check(Boolean(st), 'window-state.json 写入 miniView="month"', st ? JSON.stringify(st) : '文件里没有 miniView=month')

  console.log('  · 重启实例验证月视图持久化…')
  killTree()
  await sleep(1200)
  const main3 = await launch({ reuseUserData: true })
  const mini3 = await attach((t) => /mini\.html/.test(t.url), { ready: `!!document.querySelector('.mini')` })
  const gotGrid3 = await waitFor(mini3, `!!document.querySelector('.mini-month-grid')`, { timeout: 8000 })
  check(Boolean(gotGrid3), '重启后浮窗仍是月视图（.mini-month-grid 存在）')
  const m3 = await miniMonthSnap(mini3)
  eq(m3.title, monthTitle(today), '重启后月视图标题仍是当前月')
  const main3Ok = await waitFor(main3, `document.querySelectorAll('.cal-item').length > 0`, { timeout: 8000 })
  check(Boolean(main3Ok), '重启后主窗口正常加载')
  await openSettings(main3)
  const view3 = await readSeg(main3, VIEW_SEG)
  eq(view3?.active, ['月视图'], '重启后设置面板仍高亮「月视图」')

  // 5) 切回列表：恢复 1天标题和任务行
  await clickSeg(main3, VIEW_SEG, '列表')
  const backListOk = await waitFor(
    mini3,
    `!document.querySelector('.mini-month-grid') && document.querySelectorAll('.mini-task-row').length > 0`,
    { timeout: 6000 }
  )
  check(Boolean(backListOk), '切回「列表」后月网格消失、任务行出现')
  const backList = await miniSnap(mini3)
  eq(backList.title, md(today), '切回「列表」后标题恢复为今天的 M月d日')
  check(backList.texts.includes('MR今天'), '切回「列表」后 .mini-task-row 显示今天任务', backList.texts.join(' | '))
  const rangeBack = await readSeg(main3, RANGE_SEG)
  eq(rangeBack?.active, ['1天'], '切回列表后 .mini-range-seg 恢复且高亮 1天')
  const viewBack = await readSeg(main3, VIEW_SEG)
  eq(viewBack?.active, ['列表'], '切回列表后显示样式高亮「列表」')
  await closeSettings(main3)
  await mini3.shot('10-mini-list-back')
  return { main3, mini3 }
}

/* --------------------------------- 主流程 --------------------------------- */
async function main() {
  console.log(`Electron: ${ELECTRON}`)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const d1 = addDays(today, 1)
  const d8 = addDays(today, 8)

  let mainCdp = null
  let miniCdp = null
  mainCdp = await launch()
  console.log(`实例已起，user-data=${userDataDir}`)
  miniCdp = await attach((t) => /mini\.html/.test(t.url), { ready: `!!document.querySelector('.mini')` })
  await findMainAndMini()

  const cals = await waitCalendars()
  const calId = cals[0].id

  // 让主窗口和浮窗都拿到今天的基准数据；三条任务分别落在今/今+1/今+8
  await mcp('items_set', { calendar_id: calId, date: ymd(today), text: 'MR今天' })
  await mcp('items_set', { calendar_id: calId, date: ymd(d1), text: 'MR明天' })
  await mcp('items_set', { calendar_id: calId, date: ymd(d8), text: 'MR今天8' })
  const sawTask = await waitFor(miniCdp, `[...document.querySelectorAll('.mini-task-text')].some((e) => e.textContent.trim() === 'MR今天')`, { timeout: 8000 })
  check(Boolean(sawTask), 'MCP 写入后浮窗收到 data-changed 并显示今天任务')

  const runRange = !ONLY || String(ONLY).startsWith('range')
  const runSize = !ONLY || String(ONLY).startsWith('size')
  const runMonth = !ONLY || String(ONLY).startsWith('month')

  if (runRange) {
    await testRange(mainCdp, miniCdp, today, d1, d8, calId)
  }
  if (runSize) {
    // 尺寸测试前确保回到 1天（范围组跑过的话已经切回；单独跑也显式设一次）
    await openSettings(mainCdp)
    await clickSeg(mainCdp, RANGE_SEG, '1天').catch(() => null)
    await sleep(350)
    const got = await testSize(mainCdp, miniCdp, today)
    mainCdp = got.main2
    miniCdp = got.mini2
  }
  if (runMonth) {
    // 月视图放在尺寸组之后：此时窗口已是 480×550，月视图里再验 320 小档
    await openSettings(mainCdp)
    await clickSeg(mainCdp, RANGE_SEG, '1天').catch(() => null)
    await sleep(300)
    const got = await testMonthView(mainCdp, miniCdp, today, d1, calId)
    mainCdp = got.main3
    miniCdp = got.mini3
  }
  await closeSettings(mainCdp).catch(() => null)

  // 控制台 error：主窗口 + 所有连过的浮窗 target（含重启前后）
  groupName = 'console 控制台'
  console.log('\n== console 控制台 ==')
  const seen = new Set()
  const issues = []
  for (const c of allCdps) {
    for (const issue of c.issues()) {
      const key = `${issue.type}|${issue.text.slice(0, 200)}`
      if (seen.has(key)) continue
      seen.add(key)
      issues.push(issue)
    }
  }
  if (issues.length) {
    for (const i of issues) console.log(`  [${i.type}] ${i.text.slice(0, 500)}`)
  }
  eq(issues.length, 0, '全程没有 console error / 未捕获异常（已过滤 Electron/DevTools 噪音）')

  cleanup()
  console.log(`\n${fails.length === 0 ? '✔' : '✘'} 浮窗范围/尺寸/月视图回归：${pass} 通过 / ${fails.length} 失败`)
  if (fails.length) {
    for (const f of fails) console.log(`   ✘ ${f}`)
    if (KEEP) console.log(`\n临时 user-data 保留在：${userDataDir}`)
    process.exit(1)
  }
}

// 任何未捕获错误都要收掉 Electron 子进程，别留一堆孤儿进程
process.on('uncaughtException', (err) => {
  console.error('未捕获异常：', err)
  cleanup()
  process.exit(1)
})

main().catch((err) => {
  console.error(`\n脚本异常中断：${err?.stack ?? err}`)
  cleanup()
  process.exit(1)
})
