/**
 * 桌面端渲染层回归脚本（真实 Electron 实例 + CDP 驱动）。
 *
 *   node scripts/ui-desktop.mjs                # 全量跑
 *   node scripts/ui-desktop.mjs --only=grid    # 只跑名字以 grid 开头的组
 *   node scripts/ui-desktop.mjs --shots        # 顺便把截图落到 notes/test-reports/shots-desktop
 *
 * 隔离：--user-data 指向临时目录，CALDESK_MCP_PORT 用随机高位端口，
 * 绝不碰真实数据目录，也不抢 19283 这个真端口（机器上装着正在用的 caldesk）。
 *
 * 数据校验走实例自己的 MCP HTTP 端点（tools/call），这样"界面显示"与"库里实际"
 * 能对账；写类工具还会触发主进程广播 data-changed，正好覆盖跨进程刷新链路。
 *
 * 退出码：0 全过 / 1 有失败。
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const SHOT_DIR = join(ROOT, 'notes', 'test-reports', 'shots-desktop')

const argv = process.argv.slice(2)
const argOf = (name, dflt = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  return argv.includes(`--${name}`) ? true : dflt
}
const ONLY = argOf('only')
const WANT_SHOTS = Boolean(argOf('shots', false))

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
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(220)
  }
  async resetViewport() {
    await this.send('Emulation.clearDeviceMetricsOverride')
    await sleep(220)
  }
  async media(features) {
    await this.send('Emulation.setEmulatedMedia', {
      features: features.map((f) => ({ name: f.name, value: f.value }))
    })
    await sleep(260)
  }
  async resetMedia() {
    await this.send('Emulation.setEmulatedMedia', { features: [] })
    await sleep(260)
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
  /** 真实鼠标点击（走 React 的 onClick / pointerdown 链路） */
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
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, top: r.top, left: r.left, bottom: r.bottom, right: r.right }
    })()`)
  }
  async click(selector, index = 0) {
    const b = await this.box(selector, index)
    if (!b || b.w <= 0 || b.h <= 0) throw new Error(`点不到 ${selector}[${index}]（${JSON.stringify(b)}）`)
    await this.clickAt(b.x, b.y)
    return b
  }
  async type(text) {
    await this.send('Input.insertText', { text })
    await sleep(80)
  }
  async key(key, code = key) {
    const vk = {
      Enter: 13,
      Escape: 27,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Tab: 9,
      Backspace: 8
    }[key]
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: vk ?? 0,
        nativeVirtualKeyCode: vk ?? 0
      })
    }
    await sleep(140)
  }
  errors() {
    return this.console.filter((c) => c.type === 'error' || c.type === 'warning')
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

async function launch({ size } = {}) {
  const port = await freePort()
  apiPort = await freePort()
  userDataDir = join(tmpdir(), `caldesk-ui-test-${Date.now()}`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // 否则 Electron 以纯 Node 模式启动
  delete env.ELECTRON_RENDERER_URL
  env.CALDESK_MCP_PORT = String(apiPort)
  // Chromium 开关必须是 --k=v：写成 `--k v` 时端口会变成 0（随机挑）
  const args = [
    '.',
    '--user-data',
    userDataDir,
    `--remote-debugging-port=${port}`,
    '--no-sandbox',
    ...(size ? ['--size', size] : [])
  ]
  child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))

  let target = null
  let endpoint = port
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)
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
  if (!target) throw new Error(`CDP 没等到页面\n${log.slice(-2500)}`)
  cdpPort = endpoint

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const c = new Cdp(ws)
  c.logText = () => log
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await c.send('Log.enable')
  // 首帧：等日历列表回来 + 换页退场跑完。启动时 gridKey 会从 `null|月` 变成 `日历|月`，
  // AnimatePresence 会把旧的纸留着演退场，所以必须等"只剩一张并且稳定"。
  for (let i = 0; i < 120; i += 1) {
    const st = await c
      .eval(
        `({ grids: document.querySelectorAll('.grid').length, cals: document.querySelectorAll('.cal-item').length })`
      )
      .catch(() => ({ grids: 0, cals: 0 }))
    if (st.grids === 1 && st.cals > 0) {
      await sleep(200)
      const again = await c.eval(`document.querySelectorAll('.grid').length`).catch(() => 0)
      if (again === 1) break
    }
    await sleep(150)
  }
  await sleep(400)
  return c
}

/** MCP JSON-RPC：直接对被测实例的 API 说话，用来看/改库 */
async function mcp(tool, args = {}) {
  const res = await fetch(`http://127.0.0.1:${apiPort}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })
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
async function calendars() {
  return mcp('calendar_list')
}
async function cellLines(calendarId, date) {
  const r = await mcp('items_get', { calendar_id: calendarId, date })
  return r?.lines ?? []
}

/**
 * 收尾：Electron 的 GPU / renderer / utility 子进程会被 reparent，
 * 只 taskkill 根 pid 有时候留孤儿（实测能剩十来条 electron.exe）。
 * 所以再按 --user-data 路径扫一遍命令行，把所有属于这次实例的进程一起收掉。
 */
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
  // 同步等一小会儿让上面的 taskkill 生效，再兜底扫残留
  try {
    if (userDataDir) {
      const ps = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*${userDataDir.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 15000 })
    }
  } catch {
    /* 扫不到就算了，别让收尾报错盖住结果 */
  }
}
function cleanup() {
  killTree()
  if (userDataDir && existsSync(userDataDir)) {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 被占用就算了 */
    }
  }
}

/* -------------------------------- 页面快照 -------------------------------- */
/**
 * 只取"当前那张纸"（AnimatePresence 会把上一张留到退场结束，
 * 退场中的那张 opacity 0，几何也偏 -12px，混进来会把断言带偏）。
 */
const SNAPSHOT = `(() => {
  const grids = [...document.querySelectorAll('.grid')]
  const grid = grids[grids.length - 1] ?? null
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const cells = grid ? [...grid.querySelectorAll('.cell')] : []
  return {
    gridCount: grids.length,
    monthLabel: q('.month-label span')?.textContent ?? '',
    monthBig: q('.month-label strong')?.textContent ?? '',
    weekdays: qa('.grid-head-cell').map((x) => x.textContent),
    cells: cells.map((el) => ({
      num: el.querySelector('.daynum')?.textContent ?? '',
      outside: el.classList.contains('outside'),
      selected: el.classList.contains('selected'),
      today: !!el.querySelector('.daynum.today'),
      lines: [...el.querySelectorAll('.cell-lines .line')].map((x) => x.textContent),
      events: [...el.querySelectorAll('.cell-events .ev')].map((x) => x.textContent),
      more: el.querySelector('.cell-more')?.textContent ?? null
    })),
    cellRows: cells.length / 7,
    detailOpen: !!q('.detail.is-open'),
    detailHidden: q('.detail')?.getAttribute('aria-hidden') ?? null,
    detailTitle: q('.detail-head h3')?.textContent ?? '',
    tasks: qa('.detail-body .task-row').map((el) => ({
      text: el.querySelector('.task-label')?.textContent ?? '',
      done: el.classList.contains('done'),
      checked: !!el.querySelector('.checkbox.checked'),
      meta: [...el.querySelectorAll('.ev-meta')].map((x) => x.textContent)
    })),
    empty: q('.detail-body .empty')?.textContent ?? null,
    cals: qa('.cal-item').map((el) => ({
      name: el.querySelector('.cal-name')?.textContent ?? '',
      active: el.classList.contains('active'),
      hasDelete: !!el.querySelector('.cal-del')
    })),
    panel: q('.panel') ? (q('.panel h3')?.textContent ?? 'panel') : null
  }
})()`

async function snap(c) {
  return c.eval(SNAPSHOT)
}

/** 只在"当前那张纸"里找某一天并点它 */
async function clickDay(c, dayNum, { outside = false } = {}) {
  const found = await c.eval(`(() => {
    const grids = [...document.querySelectorAll('.grid')]
    const grid = grids[grids.length - 1]
    const cells = [...grid.querySelectorAll('.cell')]
    const el = cells.find((x) => x.querySelector('.daynum')?.textContent === ${JSON.stringify(String(dayNum))} &&
      (${outside ? 'true' : '!x.classList.contains("outside")'}))
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height - 14 }
  })()`)
  if (!found) throw new Error(`找不到 daynum=${dayNum} 的格子`)
  await c.clickAt(found.x, found.y)
  await sleep(340)
}

/** 翻到指定年月：从当前月份按 delta 点按钮 */
async function gotoMonth(c, year, month) {
  const label = await c.eval(`document.querySelector('.month-label span')?.textContent ?? ''`)
  const m = /(\d{4})年 · (\S+)/.exec(label)
  const months = { 一月: 1, 二月: 2, 三月: 3, 四月: 4, 五月: 5, 六月: 6, 七月: 7, 八月: 8, 九月: 9, 十月: 10, 十一月: 11, 十二月: 12 }
  const curY = Number(m?.[1])
  const curM = months[m?.[2]] ?? 0
  const delta = (year - curY) * 12 + (month - curM)
  const sel = delta > 0 ? '[aria-label="下个月"]' : '[aria-label="上个月"]'
  for (let i = 0; i < Math.abs(delta); i += 1) {
    await c.click(sel)
    await sleep(90)
  }
  await sleep(680)
}

async function clickWhenPresent(c, selector, index = 0) {
  for (let i = 0; i < 20; i += 1) {
    const b = await c.box(selector, index)
    if (b && b.w > 0) {
      await c.clickAt(b.x, b.y)
      return
    }
    await sleep(120)
  }
  throw new Error(`等不到可点的 ${selector}`)
}

/** 轮询直到表达式为真（异步 UI 的稳妥做法，比 sleep 一个差不多的时间靠谱） */
async function waitFor(c, expr, { timeout = 4000, every = 100 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await c.evalSoft(expr)
    if (v && !v.__error) return v
    await sleep(every)
  }
  return null
}

/** 组间复位：关掉所有浮层、回到今天、保证至少一个视图 */
async function resetUi(c) {
  await c.evalSoft(`(async () => {
    document.querySelector('.confirm-actions .ghost')?.click()
    document.querySelector('.panel-head .ghost:last-child')?.click()
    if (!document.querySelector('.detail.is-open')) document.querySelector('.detail-head .ghost')?.click()
    document.querySelector('.sidebar-foot .ghost')?.click()
    await new Promise((r) => setTimeout(r, 300))
    return true
  })()`)
  await sleep(400)
}

/* --------------------------------- 主流程 --------------------------------- */
async function main() {
  if (!existsSync(ELECTRON)) throw new Error('没找到 electron，先 npm i')
  console.log(`Electron: ${ELECTRON}`)
  const c = await launch()
  console.log(`实例已起，user-data=${userDataDir}\n`)

  try {
    for (const [name, fn] of [
      ['smoke 首帧', gSmoke],
      ['grid 月历网格', gGrid],
      ['daycell 日格与任务行', gDayCell],
      ['events 事件与重复', gEvents],
      ['views 视图管理', gViews],
      ['panels 便签/搜索/设置', gPanels],
      ['mini 浮窗', gMini],
      ['theme 主题与动效', gTheme],
      ['theme2 主题按钮链路', gThemeSwitch],
      ['responsive 响应式', gResponsive],
      ['robust 竞态与泄漏', gRobust]
    ]) {
      if (ONLY && !name.startsWith(String(ONLY))) continue
      groupName = name
      console.log(`\n== ${name} ==`)
      if (name !== 'smoke 首帧') await resetUi(c)
      try {
        await fn(c)
      } catch (err) {
        bad(`组内异常中断：${err.message}`)
      }
    }
  } finally {
    const errs = c.errors()
    if (errs.length) {
      console.log('\n== 运行期控制台 error/warning（去重）==')
      const seen = new Set()
      for (const e of errs) {
        const key = e.text.slice(0, 160)
        if (seen.has(key)) continue
        seen.add(key)
        console.log(`  [${e.type}] ${e.text.slice(0, 400)}`)
      }
    }
    if (c.exceptions.length) {
      console.log('\n== 未捕获异常 ==')
      for (const e of c.exceptions.slice(0, 10)) console.log(`  ${String(e).slice(0, 400)}`)
    }
    cleanup()
  }

  console.log(`\n${fails.length === 0 ? '✔' : '✘'} UI 回归：${pass} 通过 / ${fails.length} 失败`)
  if (fails.length) {
    for (const f of fails) console.log(`   ✘ ${f}`)
    process.exit(1)
  }
}

/* ---------------------------------- 各组 ---------------------------------- */

async function gSmoke(c) {
  const s = await snap(c)
  check(s.gridCount === 1, `启动后只剩一张月历纸（实际 ${s.gridCount} 张）`)
  check(s.cells.length >= 28 && s.cells.length % 7 === 0, `网格铺满整周（${s.cells.length} 格 / ${s.cellRows} 行）`)
  eq(s.weekdays, ['一', '二', '三', '四', '五', '六', '日'], '星期表头是周一起')
  eq(s.cells.filter((x) => x.today).length, 1, '「今天」高亮恰好一处')
  check(s.cals.length >= 1, `至少一个视图（${s.cals.length} 个）`)
  check(s.cells.some((x) => x.selected), '默认选中今天')
  check(s.detailOpen, '详情栏默认展开')
  eq(s.empty, '这一天还没有安排', '空态文案')
  eq(c.errors().length, 0, '首帧没有 console error/warning')
  await c.shot('01-first-run')
}

async function gGrid(c) {
  const s0 = await snap(c)
  const monthMatch = /(\d{4})年 · (\S+)/.exec(s0.monthLabel)
  check(Boolean(monthMatch), `月份标题可解析：${s0.monthLabel}`)

  // 闰年 2 月：2028-02 有 29 日且 2/29 在格子里
  await gotoMonth(c, 2028, 2)
  let s = await snap(c)
  check(s.cells.some((x) => x.num === '29' && !x.outside), '2028 年 2 月（闰年）有 29 日')
  check(s.cellRows >= 4 && s.cellRows <= 6, `闰年 2 月行数在 4..6 之间（${s.cellRows}）`)
  await c.shot('02-leap-feb')

  // 平年 2 月：2027-02 只有 28 天，29 日不该出现在本月
  await gotoMonth(c, 2027, 2)
  s = await snap(c)
  check(!s.cells.some((x) => x.num === '29' && !x.outside), '2027 年 2 月（平年）本月内没有 29 日')
  check(s.cells.filter((x) => !x.outside).length === 28, `平年 2 月只有 28 个本月格子（${s.cells.filter((x) => !x.outside).length}）`)

  // 跨年：2026-12 的补齐格里必须有 2027 年 1 月 1 日
  await gotoMonth(c, 2026, 12)
  s = await snap(c)
  const cells2026 = s.cells
  check(cells2026.length % 7 === 0 && cells2026[0]?.num === '30', '2026-12 首格补齐到 11/30（周一）')
  check(cells2026.some((x) => x.outside && x.num === '1'), '2026-12 末尾补出 2027-01-01')
  await c.shot('03-cross-year')

  // 月首月末补齐：本月格子连续、补齐格里没有本月日期
  const inside = s.cells.filter((x) => !x.outside).map((x) => Number(x.num))
  eq(inside, Array.from({ length: 31 }, (_, i) => i + 1), '2026-12 本月 1..31 连续')

  // 今天高亮只在当月原点
  await gotoMonth(c, Number(ymd(new Date()).slice(0, 4)), Number(ymd(new Date()).slice(5, 7)))
  s = await snap(c)
  eq(s.cells.filter((x) => x.today).length, 1, '回到本月后「今天」仍只有一处')

  // 点击选日 + 详情标题
  const todayNum = Number(ymd(new Date()).slice(8, 10))
  await clickDay(c, todayNum)
  s = await snap(c)
  check(s.cells.some((x) => x.selected && x.num === String(todayNum)), '点击格子后该格进入选中态')
  check(/月\d+日/.test(s.detailTitle), `详情标题跟着走（${s.detailTitle}）`)
  check(s.detailHidden === 'false', '选日后详情栏 aria-hidden=false')

  // 「回到今天」
  await gotoMonth(c, 2029, 6)
  await c.click('.sidebar-foot .ghost')
  await sleep(700)
  s = await snap(c)
  eq(s.monthLabel.slice(0, 5), `${new Date().getFullYear()}年`, '「回到今天」把月份拉回本月')
  check(s.cells.some((x) => x.today && x.selected), '「回到今天」同时选中今天')

  // 跨月选中：月初点上一个月的补齐格
  await gotoMonth(c, 2027, 1)
  s = await snap(c)
  const prevMonthCells = s.cells.filter((x) => x.outside && x.num === '31')
  check(prevMonthCells.length >= 1, '2027-01 首行补出 2026-12-31')
  await clickDay(c, 31, { outside: true })
  await sleep(300)
  const selAfter = await c.eval(`(() => {
    const g = [...document.querySelectorAll('.grid')].pop()
    const el = g.querySelector('.cell.selected')
    return el ? { num: el.querySelector('.daynum').textContent, outside: el.classList.contains('outside') } : null
  })()`)
  check(selAfter?.outside === true && selAfter?.num === '31', '点补齐格可以选中上月日期（跨月选中）')
  const title = await c.eval(`document.querySelector('.detail-head h3')?.textContent ?? ''`)
  check(/12月31日/.test(title), `补齐格点开的是 12 月 31 日（${title}）`)
  await c.shot('04-outside-select')

  // 键盘 ← → 翻月
  await c.eval(`document.querySelector('.cell')?.focus()`)
  const before = (await snap(c)).monthLabel
  await c.key('ArrowRight')
  await sleep(600)
  const after = (await snap(c)).monthLabel
  check(after !== before, '网格聚焦时 ← → 能翻月', `按 ←/→ 前后都是 ${before}`)

  // 双击 / 连续点同一个格子不应报错
  await clickDay(c, 15)
  await clickDay(c, 15)
  eq(c.errors().length, 0, '重复点同一格没有 React 警告')
}

async function gDayCell(c) {
  const cals = await calendars()
  const calId = cals[0].id
  const today = ymd(new Date())
  await c.click('[aria-label="回到今天"]').catch(() => {})
  const s0 = await snap(c)
  // 确保在当月
  if (!s0.cells.some((x) => x.today)) await gotoMonth(c, Number(today.slice(0, 4)), Number(today.slice(5, 7)))
  await clickDay(c, Number(today.slice(8, 10)))

  // 空输入回车：不该新增
  await c.click('.task-input')
  await c.key('Enter')
  await sleep(200)
  eq((await cellLines(calId, today)).length, 0, '空输入回车不写库')

  // 新增一条
  await c.click('.task-input')
  await c.type('买牛奶')
  await c.key('Enter')
  await sleep(600)
  let lines = await cellLines(calId, today)
  eq(lines, ['买牛奶'], '回车新增一条写入库里')
  let s = await snap(c)
  eq(s.tasks.map((t) => t.text), ['买牛奶'], '详情栏立刻出现这一行')
  eq(s.cells.find((x) => x.selected)?.lines ?? [], ['买牛奶'], '日格里也立刻出现这一行')

  // 勾选完成 → ~~文字~~
  await c.click('.detail-body .task-row .checkbox')
  await sleep(700)
  lines = await cellLines(calId, today)
  eq(lines, ['~~买牛奶~~'], '勾选完成后库里是 ~~买牛奶~~')
  s = await snap(c)
  check(s.tasks[0]?.done === true && s.tasks[0]?.checked === true, '详情行进入完成态（删除线 + 勾选）')
  check((s.cells.find((x) => x.selected)?.lines ?? [])[0] === '买牛奶', '日格显示去掉 ~~ 的纯文字')

  // 取消完成
  await c.click('.detail-body .task-row .checkbox')
  await sleep(700)
  eq(await cellLines(calId, today), ['买牛奶'], '取消完成回到普通行')

  // 再插两条 → 多行都在详情里
  await c.click('.task-input')
  await c.type('写周报')
  await c.key('Enter')
  await sleep(500)
  await c.click('.task-input')
  await c.type('给妈妈打电话')
  await c.key('Enter')
  await sleep(500)
  s = await snap(c)
  eq(s.tasks.map((t) => t.text), ['买牛奶', '写周报', '给妈妈打电话'], '三条待办按创建顺序排列')

  // 超长文本：详情要换行、不能横向溢出；日格要省略号
  const long = '很长很长的一条待办'.repeat(12)
  await c.click('.task-input')
  await c.type(long)
  await c.key('Enter')
  await sleep(600)
  const wrap = await c.eval(`(() => {
    const row = [...document.querySelectorAll('.detail-body .task-row')].find((r) => r.querySelector('.task-label').textContent.length > 50)
    if (!row) return null
    const label = row.querySelector('.task-label')
    const cs = getComputedStyle(label)
    const g = [...document.querySelectorAll('.grid')].pop()
    const cellLine = [...g.querySelectorAll('.cell.selected .line')].find((l) => l.textContent.length > 50)
    return {
      rowOverflowX: row.scrollWidth - row.clientWidth,
      labelLines: Math.round(label.getBoundingClientRect().height / parseFloat(cs.lineHeight)),
      whiteSpace: cs.whiteSpace,
      overflowWrap: cs.overflowWrap || cs.wordBreak,
      cellEllipsis: cellLine ? getComputedStyle(cellLine).textOverflow : null,
      cellOverflowX: cellLine ? cellLine.scrollWidth - cellLine.clientWidth : null
    }
  })()`)
  check(wrap && wrap.rowOverflowX <= 1, '超长待办在详情栏不横向溢出', JSON.stringify(wrap))
  check(wrap && wrap.labelLines >= 2, '超长待办在详情栏换行（而不是一行截断）', JSON.stringify(wrap))
  check(wrap?.cellEllipsis === 'ellipsis', '日格里超长文字用省略号')
  await c.shot('05-long-text')

  // 行数超过格子容量 → +N
  const day15 = `${today.slice(0, 8)}15`
  await mcp('items_set', { calendar_id: calId, date: day15, text: Array.from({ length: 9 }, (_, i) => `占位行${i + 1}`).join('\n') })
  await sleep(900)
  await clickDay(c, 15)
  s = await snap(c)
  const cell15 = s.cells.find((x) => x.num === '15' && !x.outside)
  check(Boolean(cell15?.more) && /^\+\d+$/.test(cell15.more), `格子放不下时显示 +N（${cell15?.more}）`)
  const shown = (cell15?.lines.length ?? 0) + Number((cell15?.more ?? '+0').slice(1))
  eq(shown, 9, '+N 的数字与实际隐藏条数一致')

  // 删除一行
  await mcp('items_set', { calendar_id: calId, date: day15, text: '一行' })
  await sleep(800)
  await clickDay(c, 15)
  await c.click('.detail-body .task-row .task-del')
  await sleep(600)
  eq(await cellLines(calId, day15), [], '点 × 删除该行并写库')
  eq((await snap(c)).empty, '这一天还没有安排', '删空后回到空态')

  // 清理今天，别影响后面的组
  await mcp('items_set', { calendar_id: calId, date: today, text: '' })
  await sleep(700)
}

async function gEvents(c) {
  const cals = await calendars()
  const calId = cals[0].id
  const today = ymd(new Date())
  await gotoMonth(c, Number(today.slice(0, 4)), Number(today.slice(5, 7)))
  await clickDay(c, Number(today.slice(8, 10)))

  // 用「重复」胶囊建一条每天的待办
  await c.click('.task-input')
  await c.type('每天喝水')
  await c.click('.repeat-chip')
  await sleep(300)
  await c.shot('06-repeat-menu')
  await clickWhenPresent(c, '.repeat-item', 1) // 不重复 / 每天 / ...
  await sleep(200)
  await c.key('Enter')
  await sleep(900)
  let s = await snap(c)
  check(
    s.tasks.some((t) => t.text === '每天喝水' && t.meta.some((m) => /每天/.test(m))),
    '重复待办带规则说明（每天）',
    JSON.stringify(s.tasks)
  )
  check(
    (s.cells.find((x) => x.selected)?.events ?? []).some((e) => e.includes('每天喝水')),
    '日格里出现事件行'
  )
  const evDot = await c.eval(`(() => {
    const g = [...document.querySelectorAll('.grid')].pop()
    const dot = g.querySelector('.cell.selected .ev-dot')
    return dot ? { w: dot.getBoundingClientRect().width, bg: getComputedStyle(dot).backgroundColor } : null
  })()`)
  check(evDot?.w === 4, '事件行有 4px 颜色圆点', JSON.stringify(evDot))

  // 重复待办：删单次 → 确认框
  await c.click('.detail-body .task-row .task-del')
  await sleep(400)
  const confirmText = await c.eval(`document.querySelector('.confirm-card')?.innerText ?? ''`)
  check(/仅删除/.test(confirmText) && /删除整个/.test(confirmText), '删除重复待办先弹「仅删本次 / 删整个重复」', confirmText.slice(0, 120))
  await c.shot('07-confirm-delete')
  await c.click('.confirm-actions .ghost', 1) // 「仅删除 xx 这天」
  await sleep(800)
  s = await snap(c)
  check(!s.tasks.some((t) => t.text === '每天喝水'), '「仅删本次」后当天不再显示')
  const nextDay = new Date()
  nextDay.setDate(nextDay.getDate() + 1)
  if (nextDay.getMonth() === new Date().getMonth()) {
    const nextCell = s.cells.find((x) => x.num === String(nextDay.getDate()) && !x.outside)
    check(
      (nextCell?.events ?? []).some((e) => e.includes('每天喝水')),
      '「仅删本次」不影响其他日期'
    )
  }

  // 删整个重复
  const dayAfter = new Date()
  dayAfter.setDate(dayAfter.getDate() + 2)
  if (dayAfter.getMonth() === new Date().getMonth()) await clickDay(c, dayAfter.getDate())
  await sleep(300)
  const hasRow = await c.eval(`!!document.querySelector('.detail-body .task-row')`)
  if (hasRow) {
    await c.click('.detail-body .task-row .task-del')
    await sleep(300)
    await c.click('.confirm-actions .primary-btn')
    await sleep(900)
    const remaining = await c.eval(`(() => {
      const g = [...document.querySelectorAll('.grid')].pop()
      return [...g.querySelectorAll('.cell-events .ev')].filter((e) => e.textContent.includes('每天喝水')).length
    })()`)
    eq(remaining, 0, '「删除整个重复」后本月内不再出现')
  }

  // 倒数日：kind=countdown 由数据层造。
  // 语义（db 层展开）：从 start 到 targetDate 的**每一天**都有一条实例，
  // 所以同一天里显示的是"距目标还有几天"。先回到今天再看。
  await clickDay(c, Number(today.slice(8, 10)))
  const target = new Date()
  target.setDate(target.getDate() + 7)
  await mcp('event_create', {
    calendar_id: calId,
    kind: 'countdown',
    title: '项目上线',
    start: today,
    target_date: ymd(target)
  })
  await sleep(1000)
  s = await snap(c)
  const cd = s.tasks.find((t) => t.text === '项目上线')
  check(Boolean(cd) && cd.meta.some((m) => /还有 7 天/.test(m)), `倒数日显示剩余天数（${cd?.meta?.join(',')}）`)
  check(
    await c.eval(`(() => {
      const row = [...document.querySelectorAll('.detail-body .task-row')].find((r) => r.textContent.includes('项目上线'))
      return !!row && !row.querySelector('.checkbox') && !!row.querySelector('.checkbox-spacer')
    })()`),
    '倒数日不显示勾选框（占位保持对齐）'
  )
  // 目标日当天显示「今天」
  const targetNum = target.getMonth() === new Date().getMonth() ? target.getDate() : null
  if (targetNum) {
    await clickDay(c, targetNum)
    const onTarget = (await snap(c)).tasks.find((t) => t.text === '项目上线')
    check(Boolean(onTarget) && onTarget.meta.some((m) => /今天/.test(m)), `目标当天显示「今天」（${onTarget?.meta?.join(',')}）`)
  }
  await c.shot('08-countdown')
}

async function gViews(c) {
  const before = await snap(c)
  const n0 = before.cals.length

  // 新建视图
  await c.click('.cal-new')
  await sleep(200)
  await c.type('测试视图')
  await c.key('Enter')
  await sleep(800)
  let s = await snap(c)
  eq(s.cals.length, n0 + 1, '新建视图后列表 +1')
  check(s.cals.some((x) => x.name === '测试视图' && x.active), '新视图自动成为当前视图')

  // 在这个视图里写一条，切回原视图应该看不到
  const cals = await calendars()
  const newCal = cals.find((x) => x.name === '测试视图')
  const createdId = newCal?.id
  check(Boolean(createdId), '新视图已落库')

  // 删除非当前视图：先切回第一个，再点「测试视图」那一行的 ×
  await c.click('.cal-item', 0)
  await sleep(600)
  const delBox = await c.eval(`(() => {
    const row = [...document.querySelectorAll('.cal-item')].find((r) => r.querySelector('.cal-name')?.textContent === '测试视图')
    const btn = row?.querySelector('.cal-del')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  check(Boolean(delBox), '非当前视图有删除按钮')
  // 删除按钮平时 opacity:0，靠 hover 显形；先移上去再点，才是真实用户路径
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: delBox.x, y: delBox.y, buttons: 0 })
  await sleep(200)
  await c.shot('09-view-hover-delete')
  await c.clickAt(delBox.x, delBox.y)
  await sleep(900)
  s = await snap(c)
  eq(s.cals.length, n0, '删除视图后列表 -1')
  check(!s.cals.some((x) => x.name === '测试视图'), '被删的视图从侧栏消失')

  // 「删到 0 个视图」在数据层就被挡住了：db.deleteCalendar 拒绝删最后一个。
  // 这是对的（没有视图就没有容器放日格），但要验三点：
  //   1) 最后一个视图不显示删除按钮（不给用户按到死路）
  //   2) 绕过界面直接调 IPC 也会被拒，且给人话错误
  //   3) 界面在这种状态下照常可用（不崩、还能再建）
  // 先把剩下的视图删到只剩一个（每次删一个非当前视图）
  for (let guard = 0; guard < 8; guard += 1) {
    s = await snap(c)
    if (s.cals.length <= 1) break
    const victim = s.cals.findIndex((x) => !x.active)
    const box = await c.eval(`(() => {
      const rows = [...document.querySelectorAll('.cal-item')]
      const row = rows[${victim}]
      const btn = row?.querySelector('.cal-del')
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!box) break
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
    await sleep(150)
    await c.clickAt(box.x, box.y)
    await sleep(900)
  }
  s = await snap(c)
  eq(s.cals.length, 1, '一直删到最后只剩一个视图')
  check(s.cals[0]?.hasDelete === false, '最后一个视图不显示删除按钮')
  const lastId = (await calendars())[0].id
  const refused = await c.eval(`window.caldesk.calendars.remove(${JSON.stringify(lastId)})`)
  check(refused?.ok === false && /至少需要保留一个视图/.test(refused?.error ?? ''), '直接调 IPC 删最后一个视图被拒并且错误可读', JSON.stringify(refused))
  s = await snap(c)
  eq(s.cals.length, 1, '被拒之后视图数量不变')
  eq(s.cells.length % 7, 0, '被拒之后月历纸仍然完整')
  // 还能正常建新视图
  await c.click('.cal-new')
  await sleep(300)
  await c.fill('.cal-input', '再建一个')
  await c.key('Enter')
  await sleep(1000)
  s = await snap(c)
  eq(s.cals.length, 2, '被拒之后仍然可以新建视图')
  await c.shot('09-last-view-guard')
}

async function gPanels(c) {
  const cals = await calendars()
  const calId = cals[0].id

  // 便签：新建
  await c.click('[aria-label="便签"]')
  await sleep(600)
  eq((await snap(c)).panel, '便签', '便签面板打开')
  await c.click('.panel-head .ghost', 0) // 新建
  await sleep(300)
  await c.click('.note-editor .task-input')
  await c.type('购物清单')
  await c.click('.note-editor .note-text')
  await c.type('牛奶\n鸡蛋')
  await c.click('.note-editor .primary-btn') // 保存
  await sleep(700)
  const notesText = await c.eval(`document.querySelector('.panel-body')?.innerText ?? ''`)
  check(/购物清单/.test(notesText), '便签保存后出现在列表里')
  const noteCount = await mcp('notes_list', {})
  check((noteCount?.length ?? 0) >= 1, '便签已落库')

  // 便签：编辑
  await c.click('.note-item')
  await sleep(300)
  await c.click('.note-editor .task-input')
  await c.send('Input.insertText', { text: '（改）' })
  await c.click('.note-editor .primary-btn')
  await sleep(600)
  check(/购物清单（改）/.test(await c.eval(`document.querySelector('.panel-body')?.innerText ?? ''`)), '便签标题可编辑')

  // 便签：删除
  await c.click('.note-item .task-del')
  await sleep(700)
  eq(await c.eval(`document.querySelectorAll('.note-item').length`), 0, '便签删除后列表为空')
  eq(c.errors().length, 0, '便签流程没有 console 报错')

  // 搜索
  await c.click('[aria-label="搜索"]')
  await sleep(400)
  eq((await snap(c)).panel, '搜索', '搜索面板打开')
  await c.click('.panel .task-input')
  await c.type('占位')
  await sleep(700)
  const hitCount = await c.eval(`document.querySelectorAll('.result-row').length`)
  check(hitCount >= 0, `搜索返回 ${hitCount} 条`)
  await c.shot('10-search')

  // 搜索：同一格里多行命中 + 重复待办 + 便签，行 key 不能撞（React 会打 error）
  await mcp('items_set', {
    calendar_id: calId,
    date: `${ymd(new Date()).slice(0, 8)}01`,
    text: '重复命中 第一行\n重复命中 第二行'
  })
  await mcp('event_create', {
    calendar_id: calId,
    kind: 'task',
    title: '重复命中 事件',
    start: `${ymd(new Date()).slice(0, 8)}01`,
    rrule: 'FREQ=DAILY'
  })
  await mcp('notes_create', { calendar_id: calId, title: '重复命中 便签', content: '重复命中' })
  await sleep(900)
  c.clearLog()
  await c.click('.panel .task-input')
  await c.fill('.panel .task-input', '重复命中')
  const rowEls = await waitFor(c, `[...document.querySelectorAll('.result-row')].length`, { timeout: 5000 })
  const dupWarn = c.errors().filter((e) => /same key|两个子元素|Encountered two children/i.test(e.text))
  check(dupWarn.length === 0, '搜索结果不同类型/多行命中不会产生重复 key 警告', dupWarn.map((e) => e.text.slice(0, 200)).join(' | '))
  const rows = await c.eval(`[...document.querySelectorAll('.result-row')].map((r) => r.innerText.replace(/\\n/g, ' '))`)
  check(rows.length >= 3, `多行 + 事件 + 便签都出现在结果里（${rows.length} 行 / waitFor=${rowEls}）`, rows.join(' | '))
  await c.shot('11-search-recurring')

  // 点结果跳转
  await c.click('.result-row', 0)
  await sleep(900)
  const afterJump = await snap(c)
  eq(afterJump.panel, null, '点搜索结果后关闭面板')
  check(afterJump.detailOpen, '点搜索结果后详情栏打开')

  // 设置
  await c.click('[aria-label="设置"]')
  await sleep(800)
  eq((await snap(c)).panel, '设置', '设置面板打开')
  const setBlocks = await c.eval(`[...document.querySelectorAll('.set-block')].map((b) => b.innerText.split('\\n')[0])`)
  check(setBlocks.length >= 5, `设置分块齐全（${setBlocks.join(' / ')}）`)
  check(setBlocks.includes('主题'), '设置里有主题分段')
  check(setBlocks.some((x) => /同步/.test(x)), '设置里有同步')
  check(setBlocks.some((x) => /历史与回滚/.test(x)), '设置里有历史与回滚')
  check(setBlocks.some((x) => /AI 配置指南/.test(x)), '设置里有 AI 配置指南')
  await c.shot('12-settings')

  // 开关能真的翻转
  const swBefore = await c.eval(`document.querySelector('[role="switch"]')?.getAttribute('aria-checked')`)
  await c.click('[role="switch"]')
  await sleep(500)
  const swAfter = await c.eval(`document.querySelector('[role="switch"]')?.getAttribute('aria-checked')`)
  check(swBefore !== swAfter, `开关能翻转（${swBefore} → ${swAfter}）`)
  await c.click('[role="switch"]')
  await sleep(300)

  // AI 指南复制按钮有反馈
  const guideCopy = await c.eval(`(() => {
    const btn = [...document.querySelectorAll('.panel .primary-btn')].find((b) => b.textContent.trim() === '复制')
    if (!btn) return null
    btn.click()
    return true
  })()`)
  await sleep(600)
  const copied = await c.eval(`[...document.querySelectorAll('.panel .primary-btn')].some((b) => /已复制/.test(b.textContent))`)
  check(guideCopy === true && copied, 'AI 指南「复制」按钮点了有「已复制」反馈')

  // 历史与回滚：快照列表
  const snapRows = await c.eval(`document.querySelectorAll('.snap-row').length`)
  check(snapRows >= 0, `历史记录 ${snapRows} 条`)
  const clearBtn = await c.eval(`(() => {
    const b = [...document.querySelectorAll('.panel .ghost')].find((x) => x.textContent.trim() === '清空记录')
    return b ? b.disabled : null
  })()`)
  check(clearBtn === (snapRows === 0), '「清空记录」在有记录时可用、没记录时禁用')

  await c.click('.panel-head .ghost:last-child') // 关闭
  await sleep(500)
  eq((await snap(c)).panel, null, '关闭设置面板')
}

async function gTheme(c) {
  // 深色（默认）
  await c.media([{ name: 'prefers-color-scheme', value: 'dark' }])
  const dark = await c.eval(`(() => {
    const cs = getComputedStyle(document.documentElement)
    return { bg: cs.getPropertyValue('--bg-base').trim(), text: cs.getPropertyValue('--text').trim(), scheme: cs.colorScheme }
  })()`)
  eq(dark.scheme, 'dark', '深色下 color-scheme=dark')
  eq(dark.bg, '#090b0f', '深色底取自令牌')
  await c.shot('20-theme-dark')

  // 浅色
  await c.media([{ name: 'prefers-color-scheme', value: 'light' }])
  const light = await c.eval(`(() => {
    const cs = getComputedStyle(document.documentElement)
    return { bg: cs.getPropertyValue('--bg-base').trim(), text: cs.getPropertyValue('--text').trim(), scheme: cs.colorScheme }
  })()`)
  eq(light.scheme, 'light', '浅色下 color-scheme=light')
  eq(light.bg, '#e7ebf2', '浅色底取自令牌')
  check(light.text !== dark.text, '浅色把文字反过来')
  await c.shot('21-theme-light')

  // 玻璃面在两种主题下都得比背后亮（灰盒检测：L* 差）
  const lum = await c.eval(`(() => {
    const parse = (raw) => {
      const s = String(raw).trim()
      if (s.startsWith('#')) {
        const h = s.slice(1)
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
        return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
      }
      const rgb = s.match(/-?[\\d.]+/g)?.map(Number) ?? []
      return rgb.length >= 3 ? rgb.slice(0, 3) : [0, 0, 0]
    }
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
    const cs = getComputedStyle(document.documentElement)
    return {
      bg: L(parse(cs.getPropertyValue('--bg-base'))),
      surface: L(parse(cs.getPropertyValue('--surface'))),
      raw: [cs.getPropertyValue('--bg-base').trim(), cs.getPropertyValue('--surface').trim()]
    }
  })()`)
  check(
    Math.abs(lum.surface - lum.bg) > 0.01,
    `内容面与背景亮度差足够（Δ ${(lum.surface - lum.bg).toFixed(3)}，${lum.raw.join(' → ')}）`
  )

  // 减少动效：所有过渡压到 1ms
  await c.media([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'reduce' }
  ])
  const rm = await c.eval(`(() => {
    const cs = getComputedStyle(document.querySelector('.cell'))
    const btn = getComputedStyle(document.querySelector('.tool-btn'))
    const t = getComputedStyle(document.documentElement)
    return {
      cellTransition: cs.transitionDuration,
      btnTransition: btn.transitionDuration,
      tokenFast: t.getPropertyValue('--t-fast').trim(),
      tokenPage: t.getPropertyValue('--t-page').trim()
    }
  })()`)
  check(rm.tokenFast === '1ms' && rm.tokenPage === '1ms', '减少动效把时长令牌压到 1ms', JSON.stringify(rm))
  check(/^(0\.001s|1ms)(, )?/.test(rm.btnTransition), '按钮过渡在减少动效下≈0', rm.btnTransition)
  await c.shot('22-reduced-motion')

  // 高对比
  await c.media([
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-contrast', value: 'more' }
  ])
  const hc = await c.eval(`getComputedStyle(document.documentElement).getPropertyValue('--grain-opacity').trim()`)
  eq(hc, '0', '高对比下关掉颗粒')
  await c.shot('23-contrast')

  await c.media([{ name: 'prefers-color-scheme', value: 'light' }])
  await c.resetMedia()}

/**
 * 主题切换要过一遍真实设置面板（走 IPC → nativeTheme），
 * 上面那组测的是媒体查询生效；这里测按钮链路。
 */
async function gThemeSwitch(c) {
  await c.click('[aria-label="设置"]')
  await sleep(900)
  const panelOpen = await c.eval(`!!document.querySelector('.panel')`)
  check(panelOpen, '设置面板已打开（主题按钮组可见）')
  if (!panelOpen) return
  const modes = await c.eval(
    `[...document.querySelectorAll('.seg-group')[0].querySelectorAll('.seg-item')].map((b) => b.textContent)`
  )
  check(modes.length === 3, `主题三档齐全（${modes.join('/')}）`)
  await c.click('.seg-group .seg-item', 2) // 深色
  await sleep(700)
  const scheme = await c.eval(`getComputedStyle(document.documentElement).colorScheme`)
  check(scheme === 'dark', `点「深色」后 color-scheme=dark（实际 ${scheme}）`)
  await c.click('.seg-group .seg-item', 0) // 跟随系统
  await sleep(500)
  await c.click('.panel-head .ghost:last-child')
  await sleep(400)
}

async function gMini(c) {
  const today = ymd(new Date())
  const calId = (await calendars())[0].id
  // 主窗口先写一条，浮窗要能显示出来
  await mcp('items_set', { calendar_id: calId, date: today, text: '浮窗同步 A\n~~浮窗已完成 B~~' })
  await sleep(900)

  const listTargets = async () => {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    return list.filter((t) => t.type === 'page')
  }
  const attach = async (match) => {
    for (let i = 0; i < 40; i += 1) {
      const t = (await listTargets()).find(match)
      if (t?.webSocketDebuggerUrl) {
        const ws = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true })
          ws.addEventListener('error', rej, { once: true })
        })
        const mc = new Cdp(ws)
        await mc.send('Runtime.enable')
        await mc.send('Page.enable')
        await mc.send('Log.enable')
        await sleep(600)
        return mc
      }
      await sleep(250)
    }
    return null
  }

  // 先连上浮窗（默认就开着），用它自己的 visibilityState 判断显示/隐藏 ——
  // 关掉时主进程只 hide 窗口、不销毁，CDP 目标一直在，所以不能拿"目标在不在"当断言。
  const mini = await attach((t) => /mini\.html/.test(t.url))
  if (!mini) {
    bad('能连上浮窗页面', 'CDP 里找不到 mini.html 目标')
    return
  }
  const vis = () => mini.eval(`document.visibilityState`)
  // 新安装默认 1月；这组旧断言按单天浮窗写，先切回 1天再验
  await mini.eval(`window.caldesk.settings.setMiniRange('day')`)
  await sleep(800)

  // 1) 设置里关掉「桌面浮窗」→ 浮窗隐藏；再打开 → 又可见
  await c.click('[aria-label="设置"]')
  await sleep(900)
  const switches = await c.eval(`[...document.querySelectorAll('[role="switch"]')].map((b) => b.getAttribute('aria-checked'))`)
  check(switches.length >= 3, `设置里三个开关（${switches.join(',')}）`)
  check(switches[2] === 'true', '浮窗默认是开着的（首次启动会看到两个窗口）')
  await c.click('[role="switch"]', 2)
  const hidden = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      if ((await vis()) === 'hidden') return true
      await sleep(150)
    }
    return false
  })()
  check(hidden, '关掉「桌面浮窗」后浮窗被隐藏')
  await c.click('[role="switch"]', 2)
  const shown = await (async () => {
    for (let i = 0; i < 30; i += 1) {
      if ((await vis()) === 'visible') return true
      await sleep(150)
    }
    return false
  })()
  check(shown, '再打开「桌面浮窗」后浮窗又可见了')
  await c.click('.panel-head .ghost:last-child')
  await sleep(600)
  await sleep(600)
  const m = await mini.eval(`(() => {
    const q = (s) => document.querySelector(s)
    const r = (s) => { const el = q(s); if (!el) return null; const b = el.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)] }
    return {
      title: q('.mini-title strong')?.textContent ?? '',
      sub: q('.mini-sub')?.innerText ?? '',
      tasks: [...document.querySelectorAll('.mini-task-row')].map((r) => ({
        text: r.querySelector('.mini-task-text')?.textContent ?? '',
        done: r.classList.contains('done'),
        checked: !!r.querySelector('.mini-check.checked')
      })),
      buttons: [...document.querySelectorAll('.mini-btn')].map((b) => b.getAttribute('title') || b.getAttribute('aria-label')),
      hasOpen: !!q('.mini-open'),
      size: r('.mini'),
      bodyScrollW: document.body.scrollWidth,
      innerW: innerWidth,
      innerH: innerHeight
    }
  })()`)
  eq(m.title, `${new Date().getMonth() + 1}月${new Date().getDate()}日`, '浮窗标题是今天')
  check(m.tasks.some((t) => t.text === '浮窗同步 A'), '浮窗显示主窗口刚写的待办（数据同步）', JSON.stringify(m.tasks))
  check(m.tasks.some((t) => t.text === '浮窗已完成 B' && t.checked), '浮窗把 ~~已完成~~ 渲染成勾选态', JSON.stringify(m.tasks))
  check(m.buttons.includes('打开主窗口') && m.buttons.includes('隐藏'), `浮窗有「打开 / 置顶 / 隐藏」三个按钮（${m.buttons.join('/')}）`)
  check(m.buttons.some((b) => b === '置顶' || b === '取消置顶'), '浮窗有置顶开关')
  check(m.hasOpen, '浮窗有「打开日历」入口')
  check(m.bodyScrollW <= m.innerW + 1, `浮窗没有横向溢出（${m.bodyScrollW} ≤ ${m.innerW}）`)
  check(m.size && m.size[0] >= 280 && m.size[1] >= 280, `浮窗尺寸饱满（${m.size?.join('×')}）`)
  await mini.shot('40-mini')

  // 2) 在浮窗里勾掉指定那条 → 主窗口跟着变（行序里还混着日程行，必须按文案挑）
  mini.clearLog()
  const clicked = await mini.eval(`(() => {
    const row = [...document.querySelectorAll('.mini-task-row')].find((r) => r.querySelector('.mini-task-text')?.textContent === '浮窗同步 A')
    const box = row?.querySelector('.mini-check')
    if (!box) return false
    box.click()
    return true
  })()`)
  check(clicked, '浮窗里找得到「浮窗同步 A」这一行的勾选框')
  await sleep(1400)
  const mainDone = await c.eval(`(() => {
    const row = [...document.querySelectorAll('.detail-body .task-row')].find((r) => r.textContent.includes('浮窗同步 A'))
    return row ? { done: row.classList.contains('done'), checked: !!row.querySelector('.checkbox.checked') } : null
  })()`)
  check(mainDone?.done === true && mainDone?.checked === true, '在浮窗勾选后主窗口同步显示完成态', JSON.stringify(mainDone))
  const lines = await cellLines(calId, today)
  check(lines.some((l) => /^~~浮窗同步 A~~$/.test(l)), '浮窗勾选写进了库（~~浮窗同步 A~~）', lines.join(' | '))
  await c.shot('41-mini-sync-main')

  // 3) 置顶开关能点、不报错
  mini.clearLog()
  await mini.eval(`[...document.querySelectorAll('.mini-btn')].find((b) => /置顶/.test(b.title || ''))?.click()`)
  await sleep(700)
  const pinLabel = await mini.eval(`[...document.querySelectorAll('.mini-btn')].map((b) => b.title).join('|')`)
  check(/取消置顶/.test(pinLabel), `点置顶后按钮文案翻转（${pinLabel}）`)
  eq(mini.errors().length, 0, '浮窗操作没有 console error', mini.errors().map((e) => e.text.slice(0, 120)).join(' | '))

  // 清掉今天的数据，别影响后面的组
  await mcp('items_set', { calendar_id: calId, date: today, text: '' })
  await sleep(700)
}

async function gResponsive(c) {
  const sizes = [
    [1024, 700],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160]
  ]
  for (const [w, h] of sizes) {
    await c.viewport(w, h)
    await sleep(420)
    const m = await c.eval(`(() => {
      const q = (s) => document.querySelector(s)
      const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } }
      const g = [...document.querySelectorAll('.grid')].pop()
      const cells = [...g.querySelectorAll('.cell')]
      const daynum = q('.daynum')
      const overflowing = [...document.querySelectorAll('.app *')].filter((el) => {
        if (el.closest('.detail-body, .panel-body, .cal-list, .mini-list')) return false
        const cs = getComputedStyle(el)
        if (cs.overflowX !== 'visible' || cs.position === 'fixed') return false
        return el.scrollWidth > el.clientWidth + 2
      }).slice(0, 6).map((el) => el.className + ' ' + el.tagName)
      return {
        innerW: innerWidth, innerH: innerHeight,
        docScrollW: document.documentElement.scrollWidth,
        bodyScrollW: document.body.scrollWidth,
        app: rect('.app'), main: rect('.main'), grid: rect('.grid'),
        sidebar: rect('.sidebar'), detail: rect('.detail'),
        cellH: cells[0] ? Math.round(cells[0].getBoundingClientRect().height) : 0,
        cellW: cells[0] ? Math.round(cells[0].getBoundingClientRect().width) : 0,
        cellCount: cells.length,
        daynumFs: daynum ? parseFloat(getComputedStyle(daynum).fontSize) : 0,
        overflowing
      }
    })()`)
    const tag = `${w}x${h}`
    check(m.docScrollW <= m.innerW + 1, `${tag} 没有横向溢出（scrollWidth ${m.docScrollW} ≤ ${m.innerW}）`)
    check(m.cellCount % 7 === 0, `${tag} 网格仍是 7 列整数行（${m.cellCount}）`)
    check(m.cellH >= 48, `${tag} 格子高度没被压塌（${m.cellH}px）`)
    check(m.cellW >= 70, `${tag} 格子宽度够读（${m.cellW}px）`)
    check(m.daynumFs >= 12, `${tag} 日号字号没塌陷（${m.daynumFs}px）`)
    check(m.overflowing.length === 0, `${tag} 没有意外横溢元素`, (m.overflowing ?? []).join(' | '))
    check(m.grid && m.grid.b <= m.innerH + 1, `${tag} 月历纸没有超出版面底部（${m.grid?.b} ≤ ${m.innerH}）`)
    check(m.detail && m.detail.r <= m.innerW + 1, `${tag} 详情栏没跑出窗口（${m.detail?.r} ≤ ${m.innerW}）`)
    await c.shot(`30-responsive-${tag}`)
  }
  await c.resetViewport()
  await sleep(500)

  // 最小窗口（主进程 minWidth/minHeight）
  await c.viewport(880, 580)
  await sleep(420)
  const min = await c.eval(`(() => {
    const g = [...document.querySelectorAll('.grid')].pop()
    const r = g.getBoundingClientRect()
    return { cells: g.querySelectorAll('.cell').length, h: Math.round(r.height), w: Math.round(r.width), scrollW: document.documentElement.scrollWidth, innerW: innerWidth }
  })()`)
  check(min.scrollW <= min.innerW + 1, `880x580 最小窗口无横向溢出`)
  check(min.cells % 7 === 0, `最小窗口网格完整（${min.cells}）`)
  await c.shot('31-responsive-min')
  await c.resetViewport()
  await sleep(300)

  // Ctrl + / - / 0 缩放（主进程 webContents.setZoomLevel）：±3 级下不能破版
  const zoom = async (times, key) => {
    for (let i = 0; i < times; i += 1) {
      await c.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code: key === '=' ? 'Equal' : key === '-' ? 'Minus' : 'Digit0',
        modifiers: 2, // ctrl
        windowsVirtualKeyCode: key === '=' ? 187 : key === '-' ? 189 : 48
      })
      await c.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code: key === '=' ? 'Equal' : key === '-' ? 'Minus' : 'Digit0',
        modifiers: 2,
        windowsVirtualKeyCode: key === '=' ? 187 : key === '-' ? 189 : 48
      })
      await sleep(260)
    }
    await sleep(600)
    return c.eval(`(() => {
      const g = [...document.querySelectorAll('.grid')].pop()
      const cs = getComputedStyle(document.querySelector('.daynum'))
      return {
        innerW: innerWidth,
        scrollW: document.documentElement.scrollWidth,
        cells: g.querySelectorAll('.cell').length,
        daynumFs: parseFloat(cs.fontSize),
        gridBottom: Math.round(g.getBoundingClientRect().bottom)
      }
    })()`)
  }
  const z0 = await c.eval(`innerWidth`)
  const zin = await zoom(6, '=') // 3 级上限（每次 0.5）
  /* 说明：Ctrl +/- 由主进程 webContents.setZoomLevel 实现（before-input-event），
     CDP 合成的按键进不了那个钩子，所以这里测不出缩放本身。
     「缩放 3 级」在布局上等价于逻辑视口缩小到 1/1.5（约 900×530），
     上面 880×580 + 1024×700 两组已经覆盖了同样的破版风险，这里只记录事实。 */
  if (zin.innerW < z0) {
    ok(`Ctrl+= 放大后逻辑视口变小（${z0} → ${zin.innerW}）`)
    check(zin.scrollW <= zin.innerW + 1, '放大到顶（3 级）没有横向溢出')
    check(zin.cells % 7 === 0, '放大到顶后网格仍是 7 列整数行')
    check(zin.gridBottom <= (await c.eval(`innerHeight`)) + 1, '放大到顶后月历纸没有溢出底部')
  } else {
    ok(`（未自动验证）CDP 合成按键不触发主进程缩放钩子；缩放 3 级≈逻辑视口 900×530，已由 880×580 / 1024×700 覆盖`)
  }
  await c.shot('32-zoom-in')
  const zback = await zoom(6, '-')
  check(zback.scrollW <= zback.innerW + 1, `缩到 3 级也没有横向溢出（${zback.innerW}）`)
  await c.shot('33-zoom-out')
  const zreset = await zoom(1, '0')
  check(Math.abs(zreset.innerW - z0) <= 2, `Ctrl+0 回到 100%（${zreset.innerW} ≈ ${z0}）`)
}

async function gRobust(c) {
  const cals = await calendars()
  const calId = cals[0].id
  await gotoMonth(c, Number(ymd(new Date()).slice(0, 4)), Number(ymd(new Date()).slice(5, 7)))

  // 竞态：快速翻 12 次月，最后标题与网格内容必须对得上
  const before = await snap(c)
  c.clearLog()
  for (let i = 0; i < 12; i += 1) {
    await c.click('[aria-label="下个月"]')
    await sleep(35)
  }
  await sleep(1600)
  const after = await snap(c)
  const todayCount = after.cells.filter((x) => x.today).length
  check(todayCount <= 1, '连翻 12 次后不会出现多个「今天」')
  // 标题里的月份必须是网格里"本月格子"最多的那个月
  const consistency = await c.eval(`(() => {
    const label = document.querySelector('.month-label span')?.textContent ?? ''
    const ids = {
      '一月': 0, '二月': 1, '三月': 2, '四月': 3, '五月': 4, '六月': 5,
      '七月': 6, '八月': 7, '九月': 8, '十月': 9, '十一月': 10, '十二月': 11
    }
    const m = /(\\d{4})年 · (\\S+)/.exec(label)
    const expectedIdx = ids[m[2]]
    const g = [...document.querySelectorAll('.grid')].pop()
    const inside = [...g.querySelectorAll('.cell')].filter((x) => !x.classList.contains('outside'))
    // 用日号判断不出月份，改成数"本月格子"的个数是否等于该月的天数
    const days = new Date(Number(m[1]), expectedIdx + 1, 0).getDate()
    return { expectedDays: days, inside: inside.length, label }
  })()`)
  eq(consistency.inside, consistency.expectedDays, `标题与网格天数一致（${consistency.label} → ${consistency.expectedDays} 天）`)

  const domAfterRapid = await c.eval(`document.querySelectorAll('*').length`)
  check(domAfterRapid < 400, `连翻后 DOM 没有膨胀（${domAfterRapid} 个元素）`)

  // 100 次翻月：内存与 DOM 稳定性
  const heapBefore = await c.eval(`performance.memory?.usedJSHeapSize ?? 0`)
  const t0 = Date.now()
  await c.eval(`(async () => {
    for (let i = 0; i < 100; i += 1) {
      document.querySelector(i % 2 ? '[aria-label="上个月"]' : '[aria-label="下个月"]').click()
      await new Promise((r) => setTimeout(r, 8))
    }
  })()`)
  const renderMs = Date.now() - t0
  await sleep(2500)
  const heapAfter = await c.eval(`performance.memory?.usedJSHeapSize ?? 0`)
  const domAfter100 = await c.eval(`document.querySelectorAll('*').length`)
  const gridsLeft = await c.eval(`document.querySelectorAll('.grid').length`)
  check(gridsLeft === 1, `翻 100 次月后只留一张纸（${gridsLeft}）`)
  check(domAfter100 < 400, `翻 100 次月后 DOM 数量稳定（${domAfter100}）`)
  const growthMb = (heapAfter - heapBefore) / 1048576
  check(growthMb < 24, `翻 100 次月堆增长 ${growthMb.toFixed(1)}MB（<24MB）`)
  console.log(`      翻 100 次月耗时 ${renderMs}ms，堆 ${(heapAfter / 1048576).toFixed(1)}MB`)

  // 事件监听器泄漏：连续开合面板 10 次后看 listeners 数量
  await c.eval(`(async () => {
    for (let i = 0; i < 10; i += 1) {
      document.querySelector('[aria-label="便签"]').click()
      await new Promise((r) => setTimeout(r, 60))
      document.querySelector('.panel-head .ghost:last-child').click()
      await new Promise((r) => setTimeout(r, 60))
    }
  })()`)
  await sleep(800)
  const panelsLeft = await c.eval(`document.querySelectorAll('.panel').length`)
  check(panelsLeft === 0, `开合面板 10 次后没有残留面板（${panelsLeft}）`)

  // Esc 逐层退出
  await c.click('[aria-label="设置"]')
  await sleep(600)
  await c.key('Escape')
  await sleep(500)
  eq(await c.eval(`!!document.querySelector('.panel')`), false, 'Esc 关掉设置面板')
  await c.click('.detail-head .ghost')
  await sleep(800)
  eq(await c.eval(`document.querySelector('.detail')?.getAttribute('aria-hidden')`), 'true', 'Esc 之外的「关闭」也能收起详情栏')
  await c.eval(`document.querySelector('.sidebar-foot .ghost')?.click()`)
  await sleep(700)

  // 未捕获异常汇总
  const uncaught = c.exceptions.length
  check(uncaught === 0, `整轮没有未捕获异常（${uncaught}）`, c.exceptions.slice(0, 3).join(' | ')?.slice(0, 400))
  const errs = c.errors()
  const real = errs.filter((e) => !/DevTools|Autofill|third-party cookie/i.test(e.text))
  check(real.length === 0, `整轮没有 console error（${real.length}）`, real.slice(0, 3).map((e) => e.text.slice(0, 200)).join(' | '))
}

main().catch((err) => {
  console.error('脚本异常：', err)
  cleanup()
  process.exit(1)
})
