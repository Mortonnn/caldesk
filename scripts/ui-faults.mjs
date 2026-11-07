/**
 * 渲染层健壮性回归（不起 Electron，直接在无头 Chrome 里跑构建产物 + 假宿主）。
 *
 *   node scripts/ui-faults.mjs
 *
 * 为什么要在浏览器里跑：真实的 `window.caldesk` 是 contextBridge 注入的，
 * 对象被冻结（writable:false / Object.isFrozen === true），在渲染层改不动。
 * 而渲染层的每个失败分支（IPC 抛错、返回 null、超时、空数据、乱序回包）
 * 都必须能验，所以这里换成"页面脚本执行前注入假宿主"的方式：
 *
 *   · reject  每个 API 都 Promise.reject
 *   · nullPy  每个 API 都 resolve(null)（协议被破坏的最坏情况）
 *   · hang    每个 API 都永不 resolve（IPC 卡住）
 *   · empty   正常协议但一个视图都没有
 *   · slow    正常协议，但按请求顺序人为延迟（用来逼出翻月竞态）
 *
 * 断言口径：不崩（有 .grid / .cell）、有可读的错误提示、没有未捕获异常。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createServer as netServer } from 'node:net'
import { join, resolve, dirname, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'out', 'renderer')
const SHOT_DIR = join(ROOT, 'notes', 'test-reports', 'shots-desktop')
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p))

const argv = process.argv.slice(2)
const WANT_SHOTS = argv.includes('--shots')
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice(7) || null

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
const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res, rej) => {
    const s = netServer()
    s.unref()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

/* ------------------------------ 静态文件服务 ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

function startStatic(dir) {
  return new Promise(async (res, rej) => {
    const port = await freePort()
    const server = createServer((req, resp) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let p = join(dir, decodeURIComponent(url.pathname))
      if (url.pathname === '/' || url.pathname.endsWith('/')) p = join(p, 'index.html')
      readFile(p, (err, buf) => {
        if (err) {
          resp.writeHead(404)
          resp.end('not found')
          return
        }
        resp.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
        resp.end(buf)
      })
    })
    server.listen(port, '127.0.0.1', () => res({ port, close: () => server.close() }))
  })
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
        m.error ? fail(new Error(m.error.message)) : good(m.result)
        return
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        this.console.push({
          type: m.params.type,
          text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        })
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails
        this.exceptions.push(d.exception?.description ?? d.text ?? 'unknown')
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  async evalSoft(expression) {
    try {
      return await this.eval(expression)
    } catch (err) {
      return { __error: err.message }
    }
  }
  async shot(name) {
    if (!WANT_SHOTS) return
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    mkdirSync(SHOT_DIR, { recursive: true })
    writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'))
  }
  clearLog() {
    this.console.length = 0
    this.exceptions.length = 0
  }
  unhandled() {
    return [
      ...this.exceptions,
      ...this.console.filter((c) => /Uncaught|unhandled? (promise|rejection)/i.test(c.text)).map((c) => c.text)
    ]
  }
}

/* -------------------- 注入到页面里的假宿主（page context） -------------------- */
/**
 * 这段字符串会在 document 创建时先于打包产物执行。
 * 它自己读 location.search 决定"故障模式"，并造一套内存数据。
 */
const FAKE_HOST = String.raw`(() => {
  const params = new URLSearchParams(location.search)
  const mode = params.get('mode') || 'ok'
  const today = (() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  })()

  const CAL = { id: 'cal-1', name: '工作', color: '#5b8cff', sort: 0, createdAt: 1, updatedAt: 1, deletedAt: null }
  const CAL2 = { id: 'cal-2', name: '生活', color: '#3ddc97', sort: 1, createdAt: 2, updatedAt: 2, deletedAt: null }
  const store = {
    calendars: mode === 'empty' ? [] : [CAL, CAL2],
    cells: {
      [today]: '第一条待办\n~~已完成的待办~~\n第三条待办',
      // 竞态用：每个月放一条不同的，迟到回包会把整张表冲掉、当月的内容就没了
      '2026-11-15': '十一月十五',
      '2026-12-15': '十二月十五',
      '2027-01-15': '一月十五',
      '2027-02-15': '二月十五',
      '2027-03-15': '三月十五'
    },
    events: [
      {
        date: today,
        done: false,
        event: {
          id: 'ev-1', calendarId: 'cal-1', kind: 'task', title: '每周站会', notes: null,
          allDay: true, start: today, end: null, rrule: 'FREQ=WEEKLY;BYDAY=SA',
          remindMinutes: null, targetDate: null, color: '#e0a34f', completed: false,
          createdAt: 10, updatedAt: 10, deletedAt: null
        }
      }
    ],
    notes: [],
    search: []
  }

  // 记录调用，slow 模式用它来造乱序
  const counters = {}
  window.__FAULT__ = { mode, calls: [], resolved: [], counters }

  const label = (path) => path.join('.')
  const shape = (path, fn) => {
    if (mode === 'reject') return () => Promise.reject(new Error('IPC 挂了（注入）'))
    if (mode === 'nullPy') return () => Promise.resolve(null)
    if (mode === 'hang') return () => new Promise(() => {})
    if (mode === 'slow') {
      return (...args) => {
        const key = label(path)
        const n = (counters[key] = (counters[key] ?? 0) + 1)
        // 关键：同一个方法连续调用时，**先发的后回**，逼出"迟到的旧回包覆盖新数据"
        const delay = Math.max(200, 2900 - n * 520)
        window.__FAULT__.calls.push({ fn: key, args, n })
        return new Promise((r) =>
          setTimeout(() => {
            window.__FAULT__.resolved.push({ fn: key, args, n })
            r(fn(...args))
          }, delay)
        )
      }
    }
    return fn
  }

  const okR = (v) => ({ ok: true, data: v })
  const API = {
    ping: () => Promise.resolve({ ok: true, ts: Date.now() }),
    window: {
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
      isMaximized: () => Promise.resolve(false),
      onMaximizedChange: () => () => {}
    },
    settings: {
      get: () => Promise.resolve({ miniVisible: false, miniPinned: false, autoStart: false, closeToTray: false }),
      setAutoStart: () => Promise.resolve(false),
      setCloseToTray: () => Promise.resolve(false)
    },
    calendars: {
      list: () => Promise.resolve(okR(store.calendars)),
      create: (name) => {
        const cal = { id: 'cal-' + (store.calendars.length + 1), name, color: '#ffb020', sort: 9, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null }
        store.calendars = [...store.calendars, cal]
        return Promise.resolve(okR({ created: cal, calendars: store.calendars }))
      },
      update: (id, patch) => Promise.resolve(okR(store.calendars)),
      remove: (id) => {
        store.calendars = store.calendars.filter((c) => c.id !== id)
        return Promise.resolve(okR(store.calendars))
      }
    },
    cells: {
      range: (calendarId, from, to) => {
        const rows = Object.entries(store.cells)
          .filter(([d]) => d >= from && d <= to)
          .map(([date, text]) => ({ id: calendarId + ':' + date, calendarId, date, text, color: null, updatedAt: 1, deletedAt: null }))
        return Promise.resolve(okR(rows))
      },
      get: (calendarId, date) => Promise.resolve(okR({ id: calendarId + ':' + date, calendarId, date, text: store.cells[date] ?? '', color: null, updatedAt: 1, deletedAt: null })),
      setText: (calendarId, date, text) => { store.cells[date] = text; return Promise.resolve(okR({ id: calendarId + ':' + date, calendarId, date, text, color: null, updatedAt: 1, deletedAt: null })) },
      appendLine: (calendarId, date, text) => {
        const base = store.cells[date] ?? ''
        store.cells[date] = base.trim() ? base + '\n' + text : text
        return Promise.resolve(okR({ id: calendarId + ':' + date, calendarId, date, text: store.cells[date], color: null, updatedAt: 1, deletedAt: null }))
      },
      updateLine: (calendarId, date, index, text) => {
        const lines = (store.cells[date] ?? '').split('\n')
        lines[index] = text
        store.cells[date] = lines.join('\n')
        return Promise.resolve(okR({ id: calendarId + ':' + date, calendarId, date, text: store.cells[date], color: null, updatedAt: 1, deletedAt: null }))
      },
      deleteLine: (calendarId, date, index) => {
        const lines = (store.cells[date] ?? '').split('\n')
        lines.splice(index, 1)
        store.cells[date] = lines.join('\n')
        return Promise.resolve(okR({ id: calendarId + ':' + date, calendarId, date, text: store.cells[date], color: null, updatedAt: 1, deletedAt: null }))
      },
      setDone: (calendarId, date, index, done) => {
        const lines = (store.cells[date] ?? '').split('\n')
        const plain = (lines[index] ?? '').replace(/^~~/, '').replace(/~~$/, '')
        lines[index] = done ? '~~' + plain + '~~' : plain
        store.cells[date] = lines.join('\n')
        return Promise.resolve(okR({ id: calendarId + ':' + date, calendarId, date, text: store.cells[date], color: null, updatedAt: 1, deletedAt: null }))
      }
    },
    events: {
      range: (calendarId, from, to) => Promise.resolve(okR(store.events)),
      create: (input) => {
        const ev = {
          id: 'ev-' + (store.events.length + 1), calendarId: input.calendarId, kind: input.kind,
          title: input.title, notes: null, allDay: true, start: input.start, end: null,
          rrule: input.rrule ?? null, remindMinutes: null, targetDate: input.targetDate ?? null,
          color: null, completed: false, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null
        }
        store.events = [...store.events, { date: input.start, done: false, event: ev }]
        return Promise.resolve(okR(ev))
      },
      update: (id, patch) => Promise.resolve(okR(store.events[0]?.event)),
      remove: (id) => Promise.resolve(okR(true)),
      setDone: (eventId, date, done) => Promise.resolve(okR({ event: { id: eventId }, date, done })),
      skip: (eventId, date) => Promise.resolve(okR(true))
    },
    notes: {
      list: () => Promise.resolve(okR(store.notes)),
      get: (id) => Promise.resolve(okR(store.notes.find((n) => n.id === id) ?? null)),
      create: (input) => {
        const n = { id: 'note-' + (store.notes.length + 1), calendarId: input.calendarId, title: input.title ?? '', content: input.content, pinned: false, color: null, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null }
        store.notes = [...store.notes, n]
        return Promise.resolve(okR(n))
      },
      update: (id, patch) => Promise.resolve(okR({ id, ...patch })),
      remove: (id) => { store.notes = store.notes.filter((n) => n.id !== id); return Promise.resolve(okR(true)) }
    },
    search: { query: (q) => Promise.resolve(okR(store.search)) },
    snapshots: {
      list: () => Promise.resolve([{ id: 's1', label: '写入待办', createdAt: Date.now(), updatedAt: Date.now(), count: 3, tables: ['day_cells'], current: false }]),
      restore: (id) => Promise.resolve(okR({ restored: 1, deleted: 0, failed: 0 })),
      clear: () => Promise.resolve(1)
    },
    sync: {
      getState: () => Promise.resolve({ serverUrl: '', deviceId: 'dev-1', deviceName: 'TEST-PC', accountId: '', username: '', paired: false }),
      setServer: (url, name) => Promise.resolve({ serverUrl: url, deviceId: 'dev-1', deviceName: name, accountId: '', username: '', paired: false }),
      register: () => Promise.resolve(okR({ accountId: 'acc', username: 'u', deviceId: 'dev-1', secret: 's' })),
      login: () => Promise.resolve(okR({ accountId: 'acc', username: 'u', deviceId: 'dev-1', secret: 's' })),
      claim: () => Promise.resolve(okR({ accountId: 'acc', username: 'u' })),
      logout: () => Promise.resolve(okR({ loggedOut: true })),
      me: () => Promise.resolve(okR({ accountId: 'acc', username: 'u', claimed: true, deviceId: 'dev-1', deviceName: 'TEST-PC' })),
      devices: () => Promise.resolve(okR({ devices: [], online: 0 })),
      revokeDevice: () => Promise.resolve(okR(true)),
      changes: () => Promise.resolve({ local: 0, remote: 0, changed: false, ok: true }),
      run: () => Promise.resolve({ ok: true, pushed: 0, pulled: 0, failed: 0 }),
      onDone: () => () => {}
    },
    theme: {
      getMode: () => Promise.resolve('system'),
      setMode: (m) => Promise.resolve(m)
    },
    app: { openMain: () => Promise.resolve() },
    onDataChanged: () => () => {},
    mini: {
      toggle: () => Promise.resolve(false),
      setVisible: () => Promise.resolve(false),
      hide: () => Promise.resolve(),
      pin: () => Promise.resolve(false)
    },
    mcp: { getInfo: () => Promise.resolve({ port: 19283, url: 'http://127.0.0.1:19283/mcp' }) }
  }

  // 把每个叶子方法都按 mode 包一层
  const wrap = (obj, path = []) => {
    const out = {}
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'function') out[k] = shape([...path, k], v)
      else if (v && typeof v === 'object') out[k] = wrap(v, [...path, k])
      else out[k] = v
    }
    return out
  }
  const wrapped = wrap(API)
  // onDataChanged / onDone / onMaximizedChange 必须仍然返回取消函数，不能变成"返回值是 Promise"
  wrapped.onDataChanged = () => () => {}
  wrapped.sync.onDone = () => () => {}
  wrapped.window.onMaximizedChange = () => () => {}

  Object.defineProperty(window, 'caldesk', { value: wrapped, writable: false, configurable: false })
})()
`

/* --------------------------------- 主流程 --------------------------------- */
let chrome = null
let profileDir = null
let staticServer = null

async function launch(cdpPort, url) {
  profileDir = join(tmpdir(), `caldesk-faults-${Date.now()}`)
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--window-size=1440,900',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )
  const deadline = Date.now() + 30000
  let target = null
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      if (target) break
    } catch {
      /* 等 */
    }
    await sleep(200)
  }
  if (!target) throw new Error('Chrome 没起来')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const c = new Cdp(ws)
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await c.send('Log.enable')
  // 假宿主必须在打包产物之前装好，否则 data.ts 已经缓存了真的宿主
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_HOST })
  await c.send('Page.navigate', { url })
  await sleep(1200)
  return c
}

async function scenario(c, url, mode) {
  c.clearLog()
  await c.send('Page.navigate', { url: `${url}/?mode=${mode}` })
  await sleep(1800)
}

const BASE_QUERY = `(() => {
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const grids = qa('.grid')
  const grid = grids[grids.length - 1] ?? null
  return {
    booted: !!q('.app') || !!q('.setup'),
    isApp: !!q('.app'),
    isSetup: !!q('.setup'),
    grids: grids.length,
    cells: grid ? grid.querySelectorAll('.cell').length : 0,
    lines: grid ? [...grid.querySelectorAll('.cell-lines .line')].map((x) => x.textContent) : [],
    events: grid ? [...grid.querySelectorAll('.cell-events .ev')].map((x) => x.textContent) : [],
    cals: qa('.cal-item').map((x) => x.querySelector('.cal-name')?.textContent),
    tasks: qa('.detail-body .task-row').map((x) => x.querySelector('.task-label')?.textContent),
    calError: q('.cal-error')?.textContent ?? null,
    empty: q('.detail-body .empty')?.textContent ?? null,
    bodyText: document.body.innerText.slice(0, 400),
    rootChildren: document.getElementById('root')?.children.length ?? 0
  }
})()`

async function main() {
  if (!existsSync(OUT)) throw new Error('先 npm run build（找不到 out/renderer）')
  if (!CHROME) throw new Error('找不到 Chrome')
  console.log(`Chrome: ${CHROME}`)
  staticServer = await startStatic(OUT)
  const cdpPort = await freePort()
  // 站点根目录就是 out/renderer，所以用 "/" 而不是 "/index.html"（否则拼成 index.html/ 会 404）
  const url = `http://127.0.0.1:${staticServer.port}`
  console.log(`站点: ${url}`)

  const c = await launch(cdpPort, `${url}/?mode=ok`)
  const groups = [
    ['faults 正常假宿主', gOk],
    ['faults 空数据', gEmpty],
    ['faults IPC 抛错', gReject],
    ['faults IPC 返回 null', gNull],
    ['faults IPC 卡住', gHang],
    ['faults 翻月竞态', gRace]
  ]
  try {
    for (const [name, fn] of groups) {
      if (ONLY && !name.startsWith(ONLY)) continue
      groupName = name
      console.log(`\n== ${name} ==`)
      try {
        await fn(c, url)
      } catch (err) {
        bad(`组内异常中断：${err.message}`)
      }
    }
  } finally {
    try {
      chrome?.kill()
      spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* ignore */
    }
    staticServer?.close()
    if (profileDir && existsSync(profileDir)) {
      try {
        rmSync(profileDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  console.log(`\n${fails.length === 0 ? '✔' : '✘'} 健壮性回归：${pass} 通过 / ${fails.length} 失败`)
  if (fails.length) {
    for (const f of fails) console.log(`   ✘ ${f}`)
    process.exit(1)
  }
}

async function gOk(c, url) {
  await scenario(c, url, 'ok')
  const s = await c.eval(BASE_QUERY)
  check(s.isApp, '有宿主时渲染的是主界面（不是首次配置页）')
  check(s.cells >= 28 && s.cells % 7 === 0, `网格铺满整周（${s.cells}）`)
  eq(s.cals, ['工作', '生活'], '视图列表来自宿主')
  check(s.lines.includes('第一条待办'), '日格文字来自宿主')
  check(s.tasks.some((t) => t === '第一条待办'), '详情栏列出当天待办')
  check(s.events.some((e) => e.includes('每周站会')), '事件也画在日格里')
  eq(s.grids, 1, '只有一张月历纸（没有退场残留）')
  eq(c.unhandled().length, 0, '正常路径没有未捕获异常')
  await c.shot('50-fault-ok')

  // 写一条待办：走完整交互链路
  await c.eval(`(() => {
    const input = document.querySelector('.task-input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '新增一条')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await sleep(700)
  const after = await c.eval(
    `[...document.querySelectorAll('.detail-body .task-row')].map((r) => r.querySelector('.task-label').textContent)`
  )
  check(after.includes('新增一条'), '在假宿主下新增待办也走通', JSON.stringify(after))
}

async function gEmpty(c, url) {
  await scenario(c, url, 'empty')
  const s = await c.eval(BASE_QUERY)
  check(s.isApp, '0 个视图时仍然是主界面（没有白屏）')
  eq(s.cals.length, 0, '侧栏没有视图')
  eq(s.cells % 7, 0, `0 视图时月历纸仍然完整（${s.cells} 格）`)
  eq(c.unhandled().length, 0, '0 视图时没有未捕获异常', c.unhandled().join(' | ').slice(0, 300))
  await c.shot('51-fault-zero-views')

  // 0 视图时点格子、写待办：不能崩
  await c.eval(`(() => {
    const cell = document.querySelector('.grid .cell')
    cell?.click()
  })()`)
  await sleep(400)
  await c.eval(`(() => {
    const input = document.querySelector('.task-input')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '没有视图也要能打字')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await sleep(600)
  const after = await c.evalSoft(`({ alive: !!document.querySelector('.app'), errors: document.querySelector('.cal-error')?.textContent ?? null })`)
  check(after?.alive === true, '0 视图下点格子 + 写待办之后界面还在')
  eq(c.unhandled().length, 0, '0 视图下交互没有未捕获异常', c.unhandled().join(' | ').slice(0, 300))

  // 0 视图还能新建
  await c.eval(`document.querySelector('.cal-new')?.click()`)
  await sleep(300)
  await c.eval(`(() => {
    const input = document.querySelector('.cal-input')
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '从零建一个')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })()`)
  await sleep(800)
  const created = await c.eval(`[...document.querySelectorAll('.cal-item .cal-name')].map((x) => x.textContent)`)
  check(created.includes('从零建一个'), '0 视图时能从界面新建视图', JSON.stringify(created))
}

async function gReject(c, url) {
  await scenario(c, url, 'reject')
  await sleep(1500)
  const s = await c.eval(BASE_QUERY)
  check(s.booted, '所有 IPC 都抛错时界面仍然挂上了（不是白屏）')
  check(s.cells % 7 === 0 && s.cells > 0, `网格照样画出来（${s.cells} 格）`)
  const unhandled = c.unhandled()
  check(
    unhandled.length === 0,
    'IPC 抛错时没有被吞掉的未捕获 Promise 拒绝',
    unhandled.slice(0, 3).join(' | ').slice(0, 500)
  )
  check(
    Boolean(s.calError) || /尚未接入|失败|错误|连不上/.test(s.bodyText),
    'IPC 抛错时界面给出可读提示（不是静默空着）',
    `calError=${s.calError} body=${s.bodyText.slice(0, 120)}`
  )
  await c.shot('52-fault-reject')
}

async function gNull(c, url) {
  await scenario(c, url, 'null')
  await sleep(1500)
  const s = await c.eval(BASE_QUERY)
  check(s.booted, 'IPC 返回 null 时界面仍然挂上了')
  check(s.cells % 7 === 0, `网格完整（${s.cells} 格）`)
  const unhandled = c.unhandled()
  check(unhandled.length === 0, 'IPC 返回 null 时没有未捕获异常', unhandled.slice(0, 3).join(' | ').slice(0, 500))
  await c.shot('53-fault-null')
}

async function gHang(c, url) {
  await scenario(c, url, 'hang')
  await sleep(2000)
  const s = await c.eval(BASE_QUERY)
  check(s.booted, 'IPC 永不返回时界面仍然挂上了')
  check(s.cells % 7 === 0, `网格完整（${s.cells} 格）`)
  // 卡住时点格子 / 翻月不能把界面搞崩
  await c.eval(`document.querySelector('[aria-label="下个月"]')?.click()`)
  await sleep(800)
  const s2 = await c.eval(BASE_QUERY)
  check(s2.isApp, 'IPC 卡住时翻月不会白屏')
  eq(c.unhandled().length, 0, 'IPC 卡住时没有未捕获异常', c.unhandled().slice(0, 2).join(' | ').slice(0, 300))
  await c.shot('54-fault-hang')
}

async function gRace(c, url) {
  await scenario(c, url, 'slow')
  // 先让首屏那批请求全部落地，再清计数器：这样 4 次翻月的延迟是确定的 2380/1860/1340/820
  await sleep(3200)
  await c.eval(`(() => { window.__FAULT__.counters = {}; window.__FAULT__.calls = []; window.__FAULT__.resolved = [] })()`)
  const start = await c.eval(`document.querySelector('.month-label span')?.textContent ?? ''`)
  // 连点 4 次「下个月」：请求会被故意乱序回包（后发先回）
  await c.eval(`(async () => {
    for (let i = 0; i < 4; i += 1) {
      document.querySelector('[aria-label="下个月"]').click()
      await new Promise((r) => setTimeout(r, 120))
    }
  })()`)
  await sleep(4500)
  /* 真正的断言不是几何（格子数永远由 cursor 算对），而是**内容**：
     4 次翻月后停在 2027-03，这一格必须出现「三月十五」。
     如果迟到的 2026-11 回包把 cells 整张表覆盖掉，三月这一格就是空的。 */
  const state = await c.eval(`(() => {
    const label = document.querySelector('.month-label span')?.textContent ?? ''
    const g = [...document.querySelectorAll('.grid')].pop()
    const cells = [...g.querySelectorAll('.cell')].filter((x) => !x.classList.contains('outside'))
    const day15 = cells.find((x) => x.querySelector('.daynum')?.textContent === '15')
    return {
      label,
      line15: [...(day15?.querySelectorAll('.line') ?? [])].map((x) => x.textContent),
      calls: window.__FAULT__?.calls?.length ?? 0,
      resolved: window.__FAULT__?.resolved?.map((r) => r.args[1]) ?? []
    }
  })()`)
  check(state.calls > 0, `慢宿主确实被调用（${state.calls} 次）`)
  check(/2027年 · 三月/.test(state.label), `4 次翻月后停在三月的标题（${start} → ${state.label}）`)
  check(
    state.line15.includes('三月十五'),
    '慢宿主乱序回包后，当月日格显示的是当月数据（没有被迟到的上个月回包冲掉）',
    `三月 15 日显示：${JSON.stringify(state.line15)}；回包顺序 ${JSON.stringify(state.resolved)}`
  )
  await c.shot('55-fault-race')
}

main().catch((err) => {
  console.error('脚本异常：', err)
  try {
    spawn('taskkill', ['/pid', String(chrome?.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
  staticServer?.close()
  process.exit(1)
})
