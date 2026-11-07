/**
 * 手机端可重复验证脚本（构建 → 静态服务 → 假 Worker → 无头 Chrome / CDP → 断言）。
 *
 *   node scripts/mobile-verify.mjs            全跑
 *   node scripts/mobile-verify.mjs --no-build 复用已构建的 out/mobile
 *   node scripts/mobile-verify.mjs --keep     保留临时目录
 *
 * 退出码：0 = 全过；1 = 有断言失败；2 = 脚本自身异常。
 * 截图落在 notes/test-reports/shots-mobile/。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startMock } from './mobile-mock-worker.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'out', 'mobile')
const SHOTS = join(ROOT, 'notes', 'test-reports', 'shots-mobile')
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_PORT = Number(process.env.APP_PORT ?? 4180)
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8788)
const APP_URL = `http://127.0.0.1:${APP_PORT}/index.html`
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`

const argv = process.argv.slice(2)
const NO_BUILD = argv.includes('--no-build')
const KEEP = argv.includes('--keep')

/* ------------------------------ 断言记账 ------------------------------ */

const results = []
let currentSuite = ''
function suite(name) {
  currentSuite = name
  console.log(`\n── ${name} ─────────────────────────────`)
}
function check(name, ok, detail = '') {
  results.push({ suite: currentSuite, name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  · ${detail}` : ''}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ 构建 & 静态服务 ------------------------------ */

function build() {
  return new Promise((resolvePromise, reject) => {
    console.log('▶ 构建 out/mobile …')
    const p = spawn('npm', ['run', 'build:mobile'], {
      cwd: ROOT,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d.toString()))
    p.stderr.on('data', (d) => (out += d.toString()))
    p.on('exit', (code) => {
      if (code !== 0) {
        console.error(out)
        reject(new Error(`build:mobile 失败，退出码 ${code}`))
        return
      }
      resolvePromise()
    })
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2'
}

function startStatic() {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0])
      const rel = normalize(path === '/' ? '/index.html' : path).replace(/^([/\\])+/, '')
      const file = join(OUT_DIR, rel)
      if (!file.startsWith(OUT_DIR) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      })
      createReadStream(file).pipe(res)
    })
    server.listen(APP_PORT, '127.0.0.1', () =>
      resolvePromise({ close: () => new Promise((r) => server.close(() => r())) })
    )
  })
}

/* ------------------------------ Chrome / CDP ------------------------------ */

async function launchChrome() {
  const userDataDir = join(tmpdir(), `caldesk-mobile-cdp-${Date.now()}`)
  const port = 9411
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--force-device-scale-factor=1',
    'about:blank'
  ]
  const child = spawn(CHROME, args, { stdio: 'ignore' })
  let wsUrl = ''
  for (let i = 0; i < 100; i += 1) {
    await sleep(150)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      const j = await r.json()
      wsUrl = j.webSocketDebuggerUrl
      if (wsUrl) break
    } catch {
      /* 还没起来 */
    }
  }
  if (!wsUrl) throw new Error('Chrome 没起来（CDP 端口连不上）')
  return {
    child,
    wsUrl,
    close: async () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      await sleep(150)
      if (!KEEP) {
        try {
          rmSync(userDataDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data ?? '')}`))
        else p.resolve(msg.result)
        return
      }
      const key = `${msg.sessionId ?? ''}|${msg.method}`
      for (const fn of this.handlers.get(key) ?? []) fn(msg.params)
      for (const fn of this.handlers.get(`*|${msg.method}`) ?? []) fn(msg.params)
    })
  }

  on(sessionId, method, fn) {
    const key = `${sessionId ?? ''}|${method}`
    if (!this.handlers.has(key)) this.handlers.set(key, [])
    this.handlers.get(key).push(fn)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 30000)
    })
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  const cdp = new CDP(ws)
  const page = await openPage(cdp, { width: 390, height: 844 })
  page.cdp = cdp
  return page
}

async function openPage(cdp, { width = 390, height = 844, scale = 2 } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const page = {
    targetId,
    session: sessionId,
    consoleErrors: [],
    pageErrors: [],
    send: (m, p) => cdp.send(m, p, sessionId)
  }
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Network.enable')
  cdp.on(sessionId, 'Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error') return
    page.consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '))
  })
  cdp.on(sessionId, 'Runtime.exceptionThrown', (p) => {
    page.pageErrors.push(
      p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '?'
    )
  })
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: true,
    screenWidth: width,
    screenHeight: height
  })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  return page
}

/* ------------------------------ 页面操作 ------------------------------ */

async function evaluate(page, expr) {
  const r = await page.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (r.exceptionDetails) {
    const d = r.exceptionDetails
    throw new Error(`页面脚本异常：${d.exception?.description ?? d.text}`)
  }
  return r.result?.value
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`
const qAll = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})]`

async function has(page, sel) {
  return evaluate(page, `return !!${q(sel)}`)
}
async function text(page, sel) {
  return evaluate(
    page,
    `const el = ${q(sel)}; return el ? (el.innerText || el.textContent || '').trim() : null`
  )
}
async function count(page, sel) {
  return evaluate(page, `return ${qAll(sel)}.length`)
}
async function click(page, sel) {
  return evaluate(
    page,
    `const el = ${q(sel)}; if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true`
  )
}
async function clickText(page, selector, needle) {
  return evaluate(
    page,
    `const els = ${qAll(selector)};
     const hit = els.find((e) => (e.textContent || '').includes(${JSON.stringify(needle)}));
     if (!hit) return false; hit.scrollIntoView({block:'center'}); hit.click(); return true`
  )
}
async function fill(page, sel, value) {
  return evaluate(
    page,
    `const el = ${q(sel)}; if (!el) return false;
     const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     set.call(el, ${JSON.stringify(value)});
     el.dispatchEvent(new Event('input', { bubbles: true }));
     return true`
  )
}
async function waitFor(page, sel, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await has(page, sel)) return Date.now() - start
    await sleep(60)
  }
  return -1
}
async function waitUntil(page, fn, timeout = 5000, every = 80) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return Date.now() - start
    await sleep(every)
  }
  return -1
}

async function setViewport(page, { width, height, scale = 2 }) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: true,
    screenWidth: width,
    screenHeight: height
  })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
}
async function setTheme(page, mode) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: mode }]
  })
}
async function setReducedMotion(page, on) {
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }]
  })
}

async function goto(page, url = APP_URL) {
  page.consoleErrors.length = 0
  page.pageErrors.length = 0
  await page.send('Page.navigate', { url })
  await sleep(250)
}
async function reload(page) {
  page.consoleErrors.length = 0
  page.pageErrors.length = 0
  await page.send('Page.reload')
  await sleep(200)
}

async function swipe(page, { x, y, dx, dy = 0, steps = 10, stepMs = 14 }) {
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  for (let i = 1; i <= steps; i += 1) {
    await page.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps, id: 1 }]
    })
    await sleep(stepMs)
  }
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'))
}

/**
 * 模拟安卓返回键。
 *
 * Capacitor 的 WebView 返回就是 history 回退（没有 App 插件时直接 finish 掉 Activity），
 * 所以这里用 history.back() 代表它。返回 left=true 表示这一下把页面整个退走了 ——
 * 那就说明应用没接住返回键（缺陷），这里把页面重新拉回来，让后面的断言还能继续跑。
 */
async function pressBack(page) {
  const before = await evaluate(page, `return location.href`).catch(() => null)
  try {
    /* 没接住返回键时，这一句会把页面直接导航走，求值本身可能被打断 */
    await evaluate(page, `history.back(); return true`)
  } catch {
    /* 预期之内：页面被退走了 */
  }
  await sleep(700)
  let after = null
  try {
    after = await evaluate(page, `return location.href`)
  } catch {
    after = null
  }
  const left = after === null || after !== before
  if (left) {
    await goto(page)
    await waitFor(page, '.m-shell', 8000)
  }
  return { left, before, after }
}

/** 缓存里的原始 JSON（key 可能随版本变，按前缀找） */
async function cacheRaw(page) {
  return evaluate(
    page,
    `const key = Object.keys(localStorage).find((k) => k.startsWith('caldesk.cache'));
     return key ? localStorage.getItem(key) : null`
  )
}

/* ------------------------------ 假 Worker 控制 ------------------------------ */

async function mockPost(path, body) {
  const r = await fetch(MOCK_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  return r.json()
}
async function mockState() {
  return (await fetch(`${MOCK_URL}/__mock/state`)).json()
}
async function mockLog() {
  return (await fetch(`${MOCK_URL}/__mock/log`)).json()
}
async function mockClearLog() {
  await fetch(`${MOCK_URL}/__mock/log`, { method: 'DELETE' })
}

/** 把登录页表单填好并提交 */
async function submitAuth(page, { server, username, password }) {
  await evaluate(
    page,
    `const ins = [...document.querySelectorAll('.m-setup-input')];
     const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
     const put = (el, v) => { set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
     const urlInput = ins.find((i) => i.getAttribute('inputmode') === 'url');
     put(ins[0], ${JSON.stringify(username)});
     put(ins[1], ${JSON.stringify(password)});
     if (urlInput) put(urlInput, ${JSON.stringify(server)});
     return true`
  )
  await sleep(80)
  await click(page, '.m-setup-btn')
  return waitFor(page, '.m-shell', 9000)
}

/** 某个日期格子的中心点（当前月那一页） */
async function cellPoint(page, dayNum) {
  return evaluate(
    page,
    `const cells = [...document.querySelectorAll(".m-pane:nth-child(2) .m-grid-cell")];
     const hit = cells.find((c) => !c.classList.contains("m-grid-out") &&
       c.querySelector(".m-grid-num").textContent === ${JSON.stringify(String(dayNum))});
     if (!hit) return null;
     const r = hit.getBoundingClientRect();
     return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`
  )
}

async function pagerBox(page) {
  return evaluate(
    page,
    `const r = document.querySelector('.m-pager').getBoundingClientRect();
     return { x: r.x, y: r.y, w: r.width, h: r.height }`
  )
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  if (!NO_BUILD) await build()
  if (!existsSync(join(OUT_DIR, 'index.html'))) throw new Error('out/mobile/index.html 不存在')
  mkdirSync(SHOTS, { recursive: true })

  const stat = await startStatic()
  const mock = await startMock({ port: MOCK_PORT })
  const chrome = await launchChrome()
  const page = await connect(chrome.wsUrl)
  const cdp = page.cdp
  let exitCode = 0

  try {
    /* ============================ A. 首屏与登录 ============================ */
    suite('A. 首屏 / 登录 / 冷启动')

    await goto(page)
    await evaluate(page, `try { localStorage.clear() } catch (e) {}; return true`)
    await goto(page)
    await waitFor(page, '.m-setup', 6000)
    check('未登录时是登录页（不是白屏）', await has(page, '.m-setup'))
    check('登录页有登录/注册两档', (await count(page, '.m-auth-tab')) === 2)
    check(
      '登录页有服务器地址输入框',
      await evaluate(
        page,
        `return [...document.querySelectorAll('.m-setup-input')].some((i) => i.getAttribute('inputmode') === 'url')`
      )
    )
    await shot(page, '01-setup-light')

    /* 错误地址：应该给出人话，而不是 Failed to fetch */
    await mockPost('/__mock/reset')
    await evaluate(
      page,
      `const ins = [...document.querySelectorAll('.m-setup-input')];
       const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
       const put = (el, v) => { set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
       put(ins[0], 'alice'); put(ins[1], 'Passw0rd!x'); put(ins[2], 'http://127.0.0.1:9/'); return true`
    )
    await click(page, '.m-setup-btn')
    await sleep(1400)
    const errText = await text(page, '.m-setup-error')
    check(
      '连不上服务器时给明确报错（不是静默失败）',
      Boolean(errText && errText.length > 0),
      errText ?? '(没有报错)'
    )
    check(
      '报错里带上了服务器地址，方便排查',
      Boolean(errText && errText.includes('127.0.0.1:9')),
      errText ?? ''
    )

    /* 注册 → 进主界面 */
    await mockPost('/__mock/reset')
    await evaluate(
      page,
      `const ins = [...document.querySelectorAll('.m-setup-input')];
       const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
       const put = (el, v) => { set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
       put(ins[0], 'alice'); put(ins[1], 'Passw0rd!x'); put(ins[2], '${MOCK_URL}'); return true`
    )
    await click(page, '.m-auth-tab:nth-child(2)')
    await sleep(120)
    await click(page, '.m-setup-btn')
    const registered = (await waitFor(page, '.m-shell', 9000)) >= 0
    check('注册后进入主界面', registered)
    check(
      '身份写进了 localStorage',
      await evaluate(page, `return !!localStorage.getItem('caldesk.identity')`)
    )
    const identity = await evaluate(
      page,
      `return JSON.parse(localStorage.getItem('caldesk.identity') || '{}')`
    )
    check('服务器地址写进身份且没有尾斜杠', identity.serverUrl === MOCK_URL, identity.serverUrl)
    check('设备名自动生成（不是占位符）', Boolean(identity.deviceName), identity.deviceName)

    /* 铺数据 */
    const today = await evaluate(
      page,
      `const d = new Date();
       return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')`
    )
    const todayNum = Number(today.slice(8))
    await mockPost('/__mock/seed', {
      username: 'alice',
      password: 'Passw0rd!x',
      calendars: [
        { id: 'cal-work', name: '工作', color: '#7c8cff' },
        { id: 'cal-life', name: '生活', color: '#43c59e' }
      ],
      cells: [{ calendarId: 'cal-work', date: today, text: '写移动端测试\n~~已经做完的事~~\n第三条待办' }],
      events: [
        {
          id: 'evt-weekly',
          calendarId: 'cal-work',
          kind: 'task',
          title: '每周复盘',
          start: today,
          rrule: 'FREQ=WEEKLY'
        }
      ]
    })

    /* 先把数据真正拉进缓存（这一段不测首帧），再验冷启动 */
    await reload(page)
    const warm = await waitUntil(
      page,
      async () =>
        evaluate(
          page,
          `return [...document.querySelectorAll('.m-task')].some((r) => r.textContent.includes('写移动端测试'))`
        ),
      10000
    )
    check('首次拉到当月数据', warm >= 0, `等待 ${warm}ms`)
    await sleep(400)

    /* 已登录冷启动：首帧就是真实界面（网络故意慢 900ms） */
    await mockPost('/__mock/config', { delayByPath: { '/api/': 900 } })
    const t0 = Date.now()
    await reload(page)
    /*
     * 这里不看"挂钟多少毫秒"，看"月历出现的同一帧里有没有缓存内容"：
     * 挂钟受机器负载影响（跑全量脚本时能飘到 1.8s），但"首帧是空月历还是带任务的月历"
     * 是确定的 —— 有缓存就一定先画缓存，不看网络。
     */
    let firstFrame = null
    for (let i = 0; i < 120; i += 1) {
      const snap = await evaluate(
        page,
        `const grid = document.querySelector('.m-grid-cell');
         if (!grid) return null;
         const row = [...document.querySelectorAll('.m-task')].find((r) => r.textContent.includes('写移动端测试'));
         return { grid: true, task: Boolean(row) }`
      )
      if (snap) {
        firstFrame = { at: Date.now() - t0, ...snap }
        break
      }
      await sleep(50)
    }
    await mockPost('/__mock/config', { delayByPath: {} })
    check(
      '已登录冷启动首帧就是真实界面（同一帧里已有缓存任务）',
      Boolean(firstFrame && firstFrame.task),
      JSON.stringify(firstFrame)
    )
    check('冷启动首帧耗时（参考值，含导航与解析）', Boolean(firstFrame && firstFrame.at < 3000), `${firstFrame?.at}ms`)
    check('冷启动没有 JS 异常', page.pageErrors.length === 0, page.pageErrors.join(' | '))

    /* 等网络数据回来，确认缓存被服务端覆盖 */
    const settled = await waitUntil(
      page,
      async () => (await count(page, '.m-task')) >= 4,
      10000
    )
    check('后台刷新把当月数据补齐（3 条待办 + 1 条重复待办）', settled >= 0, `等待 ${settled}ms`)

    /* ============================ B. 月历与列表 ============================ */
    suite('B. 月历 / 当天列表 / 手势')

    check('月历是 42 格（6 行 × 7 列）', (await count(page, '.m-pane:nth-child(2) .m-grid-cell')) === 42)
    const colCount = await evaluate(
      page,
      `const cells = [...document.querySelectorAll('.m-pane:nth-child(2) .m-grid-cell')];
       const top = cells[0].getBoundingClientRect().top;
       return cells.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 2).length`
    )
    check('每行正好 7 列', colCount === 7, `${colCount} 列`)
    const geom = await evaluate(
      page,
      `const rs = [...document.querySelectorAll('.m-pane:nth-child(2) .m-grid-cell')].map((c) => c.getBoundingClientRect());
       const ws = rs.map((r) => Math.round(r.width));
       return { min: Math.min(...ws), max: Math.max(...ws), h: Math.round(rs[0].height), w: Math.round(rs[0].width) }`
    )
    check(
      '格子等比、不压扁（7 列等宽）',
      Math.abs(geom.h - geom.w) <= 1 && geom.max - geom.min <= 1,
      `w=${geom.w} h=${geom.h} 列宽 ${geom.min}~${geom.max}`
    )
    const todayCells = await evaluate(
      page,
      `return [...document.querySelectorAll('.m-grid-today')].map((c) => c.querySelector('.m-grid-num').textContent)`
    )
    check(
      '今天有高亮（且高亮的是今天的日号）',
      Array.isArray(todayCells) && todayCells.length > 0 && todayCells.every((n) => Number(n) === todayNum),
      `高亮=${JSON.stringify(todayCells)} 今天=${todayNum}`
    )
    const selectedNum = await evaluate(
      page,
      `const el = document.querySelector('.m-pane:nth-child(2) .m-grid-selected .m-grid-num'); return el ? el.textContent : null`
    )
    check('默认选中今天', Number(selectedNum) === todayNum, `选中 ${selectedNum} / 今天 ${todayNum}`)
    check('已完成的行有删除线样式', await evaluate(
      page,
      `return [...document.querySelectorAll('.m-task')].some((r) =>
        r.querySelector('.m-task-text.m-task-done')?.textContent.includes('已经做完的事'))`
    ))

    /* 点选别的日期 */
    const otherDay = todayNum === 1 ? 2 : 1
    const otherPoint = await cellPoint(page, otherDay)
    if (otherPoint) {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: otherPoint.x, y: otherPoint.y, button: 'left', clickCount: 1 })
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: otherPoint.x, y: otherPoint.y, button: 'left', clickCount: 1 })
    }
    await sleep(200)
    const titleNow = await text(page, '.m-day-title')
    check('点选某天 → 当天标题跟着变', titleNow?.includes(`${otherDay}日`), titleNow ?? '')
    await click(page, '.m-today-btn')
    await sleep(200)
    check(
      '「今天」按钮回到今天',
      (await text(page, '.m-day-title'))?.includes(`${todayNum}日`),
      (await text(page, '.m-day-title')) ?? ''
    )

    /* 勾选完成 → ~~ 往返 */
    await mockClearLog()
    await evaluate(
      page,
      `const row = [...document.querySelectorAll('.m-task')].find((r) => r.textContent.includes('第三条待办'));
       row.querySelector('.m-task-check').click(); return true`
    )
    await sleep(800)
    const s1 = await mockState()
    const cell1 = s1['acc-alice'].cells[`cal-work@${today}`] ?? ''
    check('勾选完成 → 服务端行变成 ~~…~~', cell1.includes('~~第三条待办~~'), JSON.stringify(cell1))
    check('勾选后 UI 显示完成态', (await count(page, '.m-task-text.m-task-done')) >= 2)

    await evaluate(
      page,
      `const row = [...document.querySelectorAll('.m-task')].find((r) => r.textContent.includes('第三条待办'));
       row.querySelector('.m-task-check').click(); return true`
    )
    await sleep(800)
    const s2 = await mockState()
    const cell2 = s2['acc-alice'].cells[`cal-work@${today}`] ?? ''
    check(
      '取消完成 → ~~ 被去掉（往返一致）',
      cell2.includes('第三条待办') && !cell2.includes('~~第三条待办~~'),
      JSON.stringify(cell2)
    )

    /* 新增待办 */
    await click(page, '.m-fab')
    await sleep(300)
    check('加号打开弹层', await has(page, '.m-sheet.is-open'))
    await fill(page, '.m-sheet-input', '手机上新加的任务')
    await sleep(80)
    await clickText(page, '.m-sheet-actions .m-btn', '添加')
    await sleep(700)
    const s3 = await mockState()
    check(
      '新增待办写进服务端',
      (s3['acc-alice'].cells[`cal-work@${today}`] ?? '').includes('手机上新加的任务')
    )
    check(
      '新增后列表立刻出现该行',
      await evaluate(page, `return document.body.textContent.includes('手机上新加的任务')`)
    )
    check('新增后弹层关闭', !(await has(page, '.m-sheet.is-open')))

    /* 左滑删除：短滑不删、长滑删 */
    const rowBox = await evaluate(
      page,
      `const row = [...document.querySelectorAll('.m-task')].find((r) => r.textContent.includes('手机上新加的任务'));
       if (!row) return null;
       const r = row.closest('.swipe-row').getBoundingClientRect();
       return { x: r.x, y: r.y, w: r.width, h: r.height }`
    )
    if (!rowBox) {
      check('左滑删除：待删除的行在列表里', false, '找不到「手机上新加的任务」这一行')
    } else {
      await swipe(page, { x: rowBox.x + rowBox.w * 0.9, y: rowBox.y + rowBox.h / 2, dx: -rowBox.w * 0.2, steps: 8 })
      await sleep(500)
      check(
        '左滑不到阈值 → 不删除（弹回）',
        await evaluate(page, `return document.body.textContent.includes('手机上新加的任务')`)
      )
      await swipe(page, { x: rowBox.x + rowBox.w * 0.9, y: rowBox.y + rowBox.h / 2, dx: -rowBox.w * 0.62, steps: 10 })
      await sleep(900)
      const s4 = await mockState()
      check(
        '左滑过阈值 → 删除该行',
        !(s4['acc-alice'].cells[`cal-work@${today}`] ?? '').includes('手机上新加的任务')
      )
    }

    /* 删除重复待办 → 必须问「仅删这天 / 删整个重复」 */
    await evaluate(
      page,
      `const row = [...document.querySelectorAll('.m-task')].find((r) => r.textContent.includes('每周复盘'));
       row.querySelector('.m-task-del').click(); return true`
    )
    await sleep(350)
    const confirmText = await text(page, '.m-confirm')
    check('删重复待办先弹确认框', await has(page, '.m-confirm.is-open'))
    check(
      '确认框给出「仅删这天」和「删整个重复」两个选项',
      Boolean(confirmText?.includes('仅删除') && confirmText?.includes('删除整个重复')),
      (confirmText ?? '').replace(/\s+/g, ' ')
    )
    await shot(page, '02-confirm-repeat')
    await mockClearLog()
    await clickText(page, '.m-confirm-actions .m-btn', '仅删除')
    await sleep(700)
    const logSkip = await mockLog()
    const s5 = await mockState()
    check(
      '「仅删除这天」走 events/skip（不是整条删除）',
      logSkip.some((l) => l.path === '/api/events/skip') &&
        !logSkip.some((l) => l.path === '/api/events/delete')
    )
    check(
      'skip 之后这天不再出现该重复待办',
      s5['acc-alice'].skip.length > 0 &&
        !(await evaluate(page, `return document.body.textContent.includes('每周复盘')`))
    )
    check('确认框关闭', !(await has(page, '.m-confirm.is-open')))

    /* 倒数日：必须显示「还有 N 天」，而且不该有勾选框 */
    const cdDates = await evaluate(
      page,
      `const f = (x) => x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0');
       const d = new Date();
       const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 12);
       return { start: f(d), target: f(t) }`
    )
    await mockPost('/__mock/seed', {
      username: 'alice',
      password: 'Passw0rd!x',
      events: [
        {
          id: 'evt-cd',
          calendarId: 'cal-work',
          kind: 'countdown',
          title: '出发去云南',
          start: cdDates.start,
          targetDate: cdDates.target
        }
      ]
    })
    await reload(page)
    await waitFor(page, '.m-grid-cell', 8000)
    await sleep(900)
    const cdRow = await evaluate(
      page,
      `const row = [...document.querySelectorAll('.m-task')].find((r) => r.textContent.includes('出发去云南'));
       if (!row) return null;
       return { tag: (row.querySelector('.m-task-tag') || {}).textContent || '',
                hasCheck: !!row.querySelector('.m-task-check'),
                hasSpacer: !!row.querySelector('.m-task-spacer') }`
    )
    check('倒数日显示「还有 N 天」', Boolean(cdRow && /还有\s*12\s*天/.test(cdRow.tag)), JSON.stringify(cdRow))
    check(
      '倒数日没有勾选框（不是"要做的事"）',
      Boolean(cdRow && !cdRow.hasCheck && cdRow.hasSpacer),
      JSON.stringify(cdRow)
    )
    await shot(page, '12-countdown')

    /* 横滑切月 */
    let box = await pagerBox(page)
    const monthBefore = await text(page, '.m-top-month')
    await swipe(page, { x: box.x + box.w * 0.85, y: box.y + box.h * 0.5, dx: -box.w * 0.5 })
    await sleep(800)
    const monthAfter = await text(page, '.m-top-month')
    check('左滑切到下个月', monthBefore !== monthAfter, `${monthBefore} → ${monthAfter}`)
    await swipe(page, { x: box.x + box.w * 0.15, y: box.y + box.h * 0.5, dx: box.w * 0.5 })
    await sleep(800)
    check('右滑回到本月', (await text(page, '.m-top-month')) === monthBefore)

    /* 闰年 + 跨年：换一个「假时钟」页面来验 */
    const identityRaw = await evaluate(page, `return localStorage.getItem('caldesk.identity')`)
    const cacheSnapshot = await cacheRaw(page)
    async function fakeDatePage(iso) {
      const p = await openPage(cdp, { width: 390, height: 844 })
      await p.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const Real = Date;
          const fixed = Real.parse(${JSON.stringify(iso)});
          class FakeDate extends Real {
            constructor(...a) { a.length === 0 ? super(fixed) : super(...a) }
            static now() { return fixed }
          }
          window.Date = FakeDate;
        })()`
      })
      await goto(p)
      await evaluate(
        p,
        `localStorage.setItem('caldesk.identity', ${JSON.stringify(identityRaw)});
         ${cacheSnapshot ? `localStorage.setItem('caldesk.cache.v1', ${JSON.stringify(cacheSnapshot)});` : ''}
         return true`
      )
      await reload(p)
      await waitFor(p, '.m-grid-cell', 8000)
      return p
    }

    const leap = await fakeDatePage('2028-02-29T10:00:00+08:00')
    const febTitle = await text(leap, '.m-top-month')
    const has29 = await evaluate(
      leap,
      `return [...document.querySelectorAll('.m-pane:nth-child(2) .m-grid-cell')].some((c) =>
        !c.classList.contains('m-grid-out') && c.querySelector('.m-grid-num').textContent === '29')`
    )
    const todayCell29 = await evaluate(
      leap,
      `const c = document.querySelector('.m-pane:nth-child(2) .m-grid-today .m-grid-num'); return c ? c.textContent : null`
    )
    check('闰年 2 月有 29 号', febTitle === '2028年2月' && has29, `${febTitle} / 29号=${has29}`)
    check('闰年「今天」高亮落在 29 号', todayCell29 === '29', `高亮=${todayCell29}`)
    await shot(leap, '11-leap-year')
    await leap.send('Target.closeTarget', { targetId: leap.targetId }).catch(() => {})

    const newYear = await fakeDatePage('2027-12-31T10:00:00+08:00')
    const decTitle = await text(newYear, '.m-top-month')
    const nextPaneJan = await evaluate(
      newYear,
      `const pane = document.querySelector('.m-pane:nth-child(3)');
       const inMonth = [...pane.querySelectorAll('.m-grid-cell')].filter((c) => !c.classList.contains('m-grid-out'));
       return inMonth.length ? inMonth[0].querySelector('.m-grid-num').textContent : null`
    )
    check('跨年：12 月视图 + 下一页是次年 1 月', decTitle === '2027年12月' && nextPaneJan === '1', `${decTitle} / 下一页首格=${nextPaneJan}`)
    await newYear.send('Target.closeTarget', { targetId: newYear.targetId }).catch(() => {})

    /* ============================ C. 底栏 / 弹层 / 返回键 ============================ */
    suite('C. 底栏 / 弹层 / 安卓返回键')

    await goto(page)
    await waitFor(page, '.m-grid-cell', 8000)
    check(
      '底栏三项都在',
      (await count(page, '.m-dock-item')) === 3,
      (await evaluate(page, `return [...document.querySelectorAll('.m-dock-label')].map((e) => e.textContent).join('/')`)) || ''
    )
    check('默认高亮「日历」', (await text(page, '.m-dock-item-on'))?.includes('日历'))
    await clickText(page, '.m-dock-item', '即将')
    await sleep(450)
    check(
      '点「即将」切页并高亮',
      (await text(page, '.m-top-month')) === '即将' &&
        (await text(page, '.m-dock-item-on'))?.includes('即将')
    )
    await clickText(page, '.m-dock-item', '设置')
    await sleep(600)
    check('点「设置」进设置页', (await text(page, '.m-top-month')) === '设置')
    const settingsText = await text(page, '.m-view')
    check(
      '设置页显示已登录账号（不是「未登录」）',
      settingsText?.includes('alice') && !settingsText?.includes('未登录'),
      (settingsText ?? '').slice(0, 40)
    )
    check('设置页显示服务器地址', Boolean(settingsText?.includes('127.0.0.1')))
    check('设置页有设备列表分组', Boolean(settingsText?.includes('已登录设备')))
    await shot(page, '03-settings-light')

    /* 删视图是级联删除：确认区必须把「会一起删事件和便签」说清楚 */
    await click(page, '.m-icon-mini')
    await sleep(250)
    const cascadeHint = await text(page, '.m-confirm-hint')
    check(
      '删视图的确认里提示会级联删除事件和便签',
      Boolean(cascadeHint?.includes('事件') && cascadeHint?.includes('便签')),
      cascadeHint ?? '(没有提示)'
    )
    check('危险按钮用的是 m-btn-danger', await has(page, '.m-confirm-row .m-btn-danger'))
    await shot(page, '03b-delete-calendar')
    await clickText(page, '.m-confirm-row .m-btn', '取消')
    await sleep(200)

    const urlBefore = await evaluate(page, `return location.href`)
    const backFromSettings = await pressBack(page)
    check(
      '设置页按返回 → 回日历页（不退出）',
      !backFromSettings.left && (await text(page, '.m-top-month')) !== '设置',
      backFromSettings.left ? '返回把应用退走了' : `当前页=${await text(page, '.m-top-month')}`
    )

    /* 弹层 + 返回键 */
    await click(page, '.m-fab')
    await sleep(350)
    check('弹层打开', await has(page, '.m-sheet.is-open'))
    check('弹层打开时底栏收起', await has(page, '.m-dock-wrap.is-hidden'))
    const histLen = await evaluate(page, `return history.length`)
    check('弹层打开时压了一条历史记录', histLen > 1, `history.length=${histLen}`)
    await shot(page, '04-sheet-light')
    const backFromSheet = await pressBack(page)
    check(
      '弹层打开时按返回 → 关弹层而不是退出',
      !backFromSheet.left && !(await has(page, '.m-sheet.is-open')),
      backFromSheet.left ? '返回把应用退走了' : ''
    )
    check(
      '关弹层后还留在应用里',
      !backFromSheet.left && Boolean(await has(page, '.m-shell'))
    )

    await click(page, '.m-fab')
    await sleep(300)
    await evaluate(page, `document.querySelector('.m-sheet-mask').click(); return true`)
    await sleep(300)
    check('点遮罩关闭弹层', !(await has(page, '.m-sheet.is-open')))
    check(
      '点遮罩关闭后没有留下"弹层"那条历史（返回键不会空按一次）',
      await evaluate(page, `return !(history.state && history.state.caldeskOverlay)`),
      JSON.stringify(await evaluate(page, `return history.state`))
    )

    const safeArea = await evaluate(
      page,
      `const dock = document.querySelector('.m-dock-wrap');
       const probe = document.createElement('div');
       probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
       document.body.appendChild(probe);
       const envPx = getComputedStyle(probe).paddingBottom;
       probe.remove();
       return { pad: getComputedStyle(dock).paddingBottom, env: envPx,
                top: getComputedStyle(document.querySelector('.m-top')).paddingTop }`
    )
    check('底栏给底部安全区留了位置', Boolean(safeArea.pad) && safeArea.pad !== '0px', JSON.stringify(safeArea))

    /* ============================ D. 离线与缓存 ============================ */
    suite('D. 离线 / 缓存')

    await mockPost('/__mock/config', { offline: true })
    await reload(page)
    const offGrid = await waitFor(page, '.m-grid-cell', 8000)
    const offText = await waitUntil(
      page,
      async () => evaluate(page, `return document.body.textContent.includes('写移动端测试')`),
      6000
    )
    await sleep(1500)
    check('断网冷启动仍然画出月历（用缓存）', offGrid >= 0, `${offGrid}ms`)
    check('断网时缓存里的任务还在', offText >= 0, `等待 ${offText}ms`)
    check('断网有明确提示（连不上服务器）', await has(page, '.m-offline'))
    check('断网没有 JS 异常', page.pageErrors.length === 0, page.pageErrors.slice(0, 2).join(' | '))
    await shot(page, '05-offline')
    await mockPost('/__mock/config', { offline: false })
    const recovered = await waitUntil(page, async () => !(await has(page, '.m-offline')), 15000, 400)
    check('恢复网络后提示自动消失', recovered >= 0, `等待 ${recovered}ms`)

    /* 结构变了的旧缓存 */
    await evaluate(
      page,
      `localStorage.setItem('caldesk.cache.v1', JSON.stringify({ calendars: 'oops', cellsByCal: 3, eventsByCal: null, calId: 42 })); return true`
    )
    await reload(page)
    const badCache = await waitFor(page, '.m-shell', 6000)
    check('结构变了的旧缓存不会把界面搞崩', badCache >= 0)
    check('坏缓存时不抛异常', page.pageErrors.length === 0, page.pageErrors.slice(0, 2).join(' | '))

    /* ============================ D2. 换服务器 / 换账号 ============================ */
    suite('D2. 换服务器 / 换账号不串号')

    await mockPost('/__mock/reset')
    await mockPost('/__mock/seed', {
      username: 'alice',
      password: 'Passw0rd!x',
      calendars: [{ id: 'cal-a', name: 'A 的日历', color: '#7c8cff' }],
      cells: [{ calendarId: 'cal-a', date: today, text: 'A 的秘密任务' }]
    })
    await mockPost('/__mock/seed', {
      username: 'bob',
      password: 'Passw0rd!y',
      calendars: [{ id: 'cal-b', name: 'B 的日历', color: '#43c59e' }],
      cells: [{ calendarId: 'cal-b', date: today, text: 'B 自己的任务' }]
    })
    await evaluate(
      page,
      `localStorage.removeItem('caldesk.identity'); localStorage.removeItem('caldesk.cache.v1'); return true`
    )
    await reload(page)
    await waitFor(page, '.m-setup', 6000)
    const loginA = (await submitAuth(page, { server: MOCK_URL, username: 'alice', password: 'Passw0rd!x' })) >= 0
    check('A 登录成功', loginA)
    await waitFor(page, '.m-grid-cell', 6000)
    const aVisible = await waitUntil(
      page,
      async () => evaluate(page, `return document.body.textContent.includes('A 的秘密任务')`),
      8000
    )
    check('A 看到自己的任务', aVisible >= 0)
    check(
      'A 的数据写进了缓存',
      String((await cacheRaw(page)) ?? '').includes('A 的秘密任务')
    )

    /* 改服务器地址 → 会退出登录 */
    await clickText(page, '.m-dock-item', '设置')
    await sleep(600)
    await evaluate(
      page,
      `const input = document.querySelector('.m-set-input');
       const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
       set.call(input, '${MOCK_URL.replace(String(MOCK_PORT), String(MOCK_PORT + 1))}');
       input.dispatchEvent(new Event('input', { bubbles: true })); return true`
    )
    await sleep(120)
    await clickText(page, '.m-set-row .m-side-btn', '保存')
    await sleep(800)
    check('改服务器地址后回到未登录态', await has(page, '.m-setup'))
    const cacheAfter = String((await cacheRaw(page)) ?? '')
    check(
      '换服务器后旧账号缓存被清掉（不留给下一个账号）',
      !cacheAfter.includes('A 的秘密任务'),
      cacheAfter.slice(0, 120)
    )

    /* 下一个账号登录 */
    await evaluate(
      page,
      `const ins = [...document.querySelectorAll('.m-setup-input')];
       const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
       const put = (el, v) => { set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
       const urlInput = ins.find((i) => i.getAttribute('inputmode') === 'url');
       put(ins[0], 'bob'); put(ins[1], 'Passw0rd!y'); put(urlInput, '${MOCK_URL}'); return true`
    )
    await sleep(100)
    await click(page, '.m-setup-btn')
    await waitFor(page, '.m-shell', 9000)
    await sleep(900)
    const bobSees = await evaluate(
      page,
      `return { other: document.body.textContent.includes('A 的秘密任务'),
                own: document.body.textContent.includes('B 自己的任务') }`
    )
    check('换账号后看不到上一个人的任务', bobSees.other === false, JSON.stringify(bobSees))
    await reload(page)
    await waitFor(page, '.m-grid-cell', 8000)
    await sleep(1200)
    const bobCold = await evaluate(page, `return document.body.textContent.includes('A 的秘密任务')`)
    check('换账号冷启动也看不到上一个人的任务', bobCold === false)

    /* ============================ E. 视觉 / 响应式 ============================ */
    suite('E. 视觉 / 响应式')

    for (const [w, h] of [
      [360, 640],
      [412, 915],
      [390, 844]
    ]) {
      await setViewport(page, { width: w, height: h })
      await goto(page)
      await waitFor(page, '.m-grid-cell', 8000)
      await sleep(250)
      const overflow = await evaluate(
        page,
        `const de = document.documentElement;
         return { scrollW: de.scrollWidth, clientW: de.clientWidth,
                  bodyScrollW: document.body.scrollWidth,
                  titleOverflow: (() => { const t = document.querySelector('.m-top-month'); return t ? t.scrollWidth - t.clientWidth : 0 })() }`
      )
      check(
        `${w}x${h}：没有横向滚动条`,
        overflow.scrollW <= overflow.clientW + 1 && overflow.bodyScrollW <= overflow.clientW + 1,
        JSON.stringify(overflow)
      )
      const grid = await evaluate(
        page,
        `const r = document.querySelector('.m-pane:nth-child(2) .m-grid-cell').getBoundingClientRect();
         return { w: Math.round(r.width), h: Math.round(r.height) }`
      )
      check(`${w}x${h}：格子没被压扁`, Math.abs(grid.w - grid.h) <= 1 && grid.w >= 40, JSON.stringify(grid))
      const dock = await evaluate(
        page,
        `const r = document.querySelector('.m-dock').getBoundingClientRect();
         return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth }`
      )
      check(`${w}x${h}：底栏不超出屏幕`, dock.left >= 0 && dock.right <= dock.vw + 1, JSON.stringify(dock))
      await shot(page, `06-layout-${w}x${h}`)
    }

    await setViewport(page, { width: 390, height: 844 })
    await setTheme(page, 'dark')
    await goto(page)
    await waitFor(page, '.m-grid-cell', 8000)
    await sleep(350)
    const darkBg = await evaluate(
      page,
      `return getComputedStyle(document.getElementById('root')).backgroundColor`
    )
    check('暗色主题生效', darkBg !== 'rgba(0, 0, 0, 0)', darkBg)
    await shot(page, '07-dark')
    await setTheme(page, 'light')
    await sleep(250)
    await shot(page, '08-light')

    /* 减弱动效 */
    await setReducedMotion(page, true)
    await goto(page)
    await waitFor(page, '.m-grid-cell', 6000)
    const rmBefore = await text(page, '.m-top-month')
    box = await pagerBox(page)
    await swipe(page, { x: box.x + box.w * 0.85, y: box.y + box.h * 0.5, dx: -box.w * 0.5, steps: 8 })
    await sleep(700)
    check('prefers-reduced-motion 下照样能切月', (await text(page, '.m-top-month')) !== rmBefore)
    await setReducedMotion(page, false)

    /* 低端机材质档 */
    const mpage = await openPage(cdp, { width: 390, height: 844 })
    try {
      await mpage.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 2 })
    } catch {
      /* 不支持就按结果判断 */
    }
    await goto(mpage)
    await waitFor(mpage, '.m-grid-cell', 8000)
    const mat = await evaluate(
      mpage,
      `return { mat: document.documentElement.dataset.mat, glass: document.documentElement.dataset.glass,
                hc: navigator.hardwareConcurrency }`
    )
    check('低端机降级到 plain 材质档（安卓 WebView 不做 backdrop-filter）', mat.mat === 'plain', JSON.stringify(mat))
    await shot(mpage, '09-plain-material')
    await mpage.send('Target.closeTarget', { targetId: mpage.targetId }).catch(() => {})

    /* ============================ F. 请求风暴 / 乱序 ============================ */
    suite('F. 窗口化拉取 / 请求风暴 / 乱序')

    await goto(page)
    await waitFor(page, '.m-grid-cell', 8000)
    await sleep(700)
    await mockClearLog()
    box = await pagerBox(page)
    for (let i = 0; i < 3; i += 1) {
      await swipe(page, { x: box.x + box.w * 0.85, y: box.y + box.h * 0.5, dx: -box.w * 0.5, steps: 6, stepMs: 8 })
      await sleep(200)
    }
    await sleep(1200)
    const logSwipes = await mockLog()
    const cellCalls = logSwipes.filter((l) => l.path === '/api/cells').length
    check('连翻三个月没有请求风暴（/api/cells ≤ 4 次）', cellCalls <= 4, `${cellCalls} 次（共 ${logSwipes.length} 次请求）`)

    /*
     * 乱序响应：一次「切回前台」（force，窗口窄）故意慢，翻月的请求（窗口宽）快。
     * 慢的那段如果后到还写状态，就会把宽窗口的数据盖成窄窗口的 ——
     * 现象是"翻到下个月，下下个月的点先出来又消失"。
     *
     * 为了让差别看得见，在「下下个月」放一条任务：只有宽窗口才包含它。
     */
    const nextMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 2, 5)
    const probeDate = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-05`
    await mockPost('/__mock/seed', {
      username: 'bob',
      password: 'Passw0rd!y',
      cells: [{ calendarId: 'cal-b', date: probeDate, text: '只在宽窗口里' }]
    })
    await goto(page)
    await waitFor(page, '.m-grid-cell', 8000)
    await sleep(2200) /* 等出 FRESH_MS，force 才会真发请求 */
    box = await pagerBox(page)
    await mockPost('/__mock/config', { cellDelayQueue: [1600, 0, 0, 0] })
    /* 1) force：窄窗口（慢） */
    await evaluate(page, `window.dispatchEvent(new Event('focus')); return true`)
    await sleep(150)
    /* 2) 翻月：宽窗口（快） */
    await swipe(page, { x: box.x + box.w * 0.85, y: box.y + box.h * 0.5, dx: -box.w * 0.5, steps: 6, stepMs: 8 })
    await sleep(900)
    const probeDot = `[...document.querySelectorAll('.m-pane:nth-child(3) .m-grid-cell')]
      .filter((c) => !c.classList.contains('m-grid-out'))
      .map((c) => ({ n: c.querySelector('.m-grid-num').textContent, dot: !!c.querySelector('.m-grid-dot-task') }))`
    const dotBeforeStale = await evaluate(
      page,
      `return ${probeDot}.find((c) => c.n === '5')`
    )
    check(
      '翻月后「下下个月」的点先出现了（宽窗口生效）',
      Boolean(dotBeforeStale?.dot),
      JSON.stringify(dotBeforeStale)
    )
    /* 3) 等慢响应到齐：它不能把宽窗口的数据盖掉 */
    await sleep(2200)
    await mockPost('/__mock/config', { cellDelayQueue: [] })
    const dotAfterStale = await evaluate(page, `return ${probeDot}.find((c) => c.n === '5')`)
    check(
      '慢响应（旧窗口）后到也没有盖掉新数据',
      Boolean(dotAfterStale?.dot),
      JSON.stringify(dotAfterStale)
    )
    const raceTitle = await text(page, '.m-top-month')
    const expectD = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
    const expected = `${expectD.getFullYear()}年${expectD.getMonth() + 1}月`
    check('乱序后仍然停在用户翻到的那一月', raceTitle === expected, `标题=${raceTitle} 期望=${expected}`)
    await shot(page, '10-after-race')

    /* 切回前台刷新 */
    await sleep(2000)
    await mockClearLog()
    await evaluate(page, `window.dispatchEvent(new Event('focus')); return true`)
    await sleep(1000)
    const logFocus = await mockLog()
    check(
      '切回前台（focus）会刷新一次数据',
      logFocus.some((l) => l.path === '/api/cells'),
      `${logFocus.length} 次请求`
    )

    /* ============================ 汇总 ============================ */
    suite('汇总')
    check('运行期间没有未捕获异常（主页面）', page.pageErrors.length === 0, page.pageErrors.slice(0, 3).join(' | '))
  } catch (err) {
    console.error('\n验证脚本异常：', err)
    exitCode = 2
  } finally {
    const failed = results.filter((r) => !r.ok)
    exitCode = exitCode || (failed.length ? 1 : 0)
    console.log(`\n${'='.repeat(64)}`)
    console.log(`共 ${results.length} 项断言，通过 ${results.length - failed.length}，失败 ${failed.length}`)
    for (const f of failed) console.log(`  ❌ [${f.suite}] ${f.name}${f.detail ? ` · ${f.detail}` : ''}`)
    console.log(`截图目录：${SHOTS}`)
    try {
      await chrome.close()
      await stat.close()
      await mock.close()
    } catch {
      /* ignore */
    }
  }
  process.exit(exitCode)
}

main()
