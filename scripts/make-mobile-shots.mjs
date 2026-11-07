/**
 * 生成 README 所需的干净通用 Demo 手机端高清截图：
 * 1. screenshot-mobile-light.png
 * 2. screenshot-mobile-dark.png
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startMock } from './mobile-mock-worker.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'out', 'mobile')
const PUBLIC_DOCS = resolve(ROOT, '..', '..', 'caldesk-public', 'docs')
const LOCAL_DOCS = join(ROOT, 'docs')
const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const APP_PORT = 4199
const MOCK_PORT = 8799
const APP_URL = `http://127.0.0.1:${APP_PORT}/index.html`
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function launchChrome() {
  const port = 9399
  const userDataDir = join(tmpdir(), `caldesk-shot-chrome-${Date.now()}`)
  mkdirSync(userDataDir, { recursive: true })
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-background-networking',
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
      /* wait */
    }
  }
  if (!wsUrl) throw new Error('Chrome 启动失败')
  return {
    child,
    wsUrl,
    close: async () => {
      try {
        child.kill()
      } catch {}
      await sleep(150)
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {}
    }
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 15000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (r.exceptionDetails) {
      throw new Error(`页面脚本异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
    }
    return r.result?.value
  }
}

async function main() {
  console.log('[make-mobile-shots] 启动静态服务与 Mock Worker...')
  const stat = await startStatic()
  const mock = await startMock({ port: MOCK_PORT })
  const chrome = await launchChrome()

  const list = await (await fetch(`http://127.0.0.1:9399/json/list`)).json()
  const pageTarget = list.find((t) => t.type === 'page')
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })

  const cdp = new CDP(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 设置高清移动视口：390 x 844, dpr 3
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

  // 灌入完全通用且与桌面端对应的日常 Demo 数据
  const today = '2026-11-07'
  const seedRes = await fetch(`${MOCK_URL}/__mock/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'caldesk_user',
      password: 'Passw0rd!demo',
      calendars: [
        { id: 'cal-work', name: '工作', color: '#7c8cff' },
        { id: 'cal-life', name: '生活', color: '#43c59e' }
      ],
      cells: [
        {
          calendarId: 'cal-work',
          date: today,
          // 占位串：README 截图里不出现任何具体事务
          text: '111\n221\n234\n~~测试~~'
        }
      ],
      events: [
        {
          id: 'evt-repeat',
          calendarId: 'cal-work',
          kind: 'task',
          title: '222',
          start: today,
          rrule: 'FREQ=WEEKLY'
        },
        {
          id: 'evt-countdown',
          calendarId: 'cal-life',
          kind: 'countdown',
          title: '333',
          start: today,
          targetDate: '2026-11-20'
        }
      ]
    })
  })
  const seed = await seedRes.json()
  console.log('[make-mobile-shots] Seed 成功:', seed)

  // 导航至首页
  await cdp.send('Page.navigate', { url: APP_URL })
  await sleep(600)

  // 模拟输入登录
  console.log('[make-mobile-shots] 执行登录...')
  await cdp.eval(`
    const put = (el, v) => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('.m-setup-input')];
    put(inputs[0], 'caldesk_user');
    put(inputs[1], 'Passw0rd!demo');
    const urlInput = inputs.find((i) => i.getAttribute('inputmode') === 'url');
    if (urlInput) put(urlInput, ${JSON.stringify(MOCK_URL)});
  `)
  await sleep(100)

  // 点击登录按钮
  await cdp.eval(`document.querySelector('.m-setup-btn').click()`)

  // 等待进入主页面
  console.log('[make-mobile-shots] 等待主月历与任务渲染...')
  for (let i = 0; i < 80; i += 1) {
    const ready = await cdp.eval(`
      const cell = document.querySelector('.m-grid-cell');
      const task = document.querySelector('.m-task');
      return Boolean(cell && task);
    `).catch(() => false)
    if (ready) break
    await sleep(200)
  }
  await sleep(800)

  // 确保选中今天 7 号
  await cdp.eval(`
    const todayCell = document.querySelector('.m-grid-cell.m-grid-today') || 
      [...document.querySelectorAll('.m-grid-cell')].find(c => c.textContent.trim().startsWith('7'));
    if (todayCell) todayCell.click();
  `)
  await sleep(400)

  mkdirSync(PUBLIC_DOCS, { recursive: true })
  mkdirSync(LOCAL_DOCS, { recursive: true })

  const saveShot = (filename, buf) => {
    writeFileSync(join(PUBLIC_DOCS, filename), buf)
    writeFileSync(join(LOCAL_DOCS, filename), buf)
    console.log(`[make-mobile-shots] 已保存: ${filename} (${buf.length} bytes)`)
  }

  // 1. 截取浅色模式
  console.log('[make-mobile-shots] 截取移动端浅色模式...')
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }]
  })
  await sleep(600)
  const shotLight = await cdp.send('Page.captureScreenshot', { format: 'png' })
  saveShot('screenshot-mobile-light.png', Buffer.from(shotLight.data, 'base64'))

  // 2. 截取深色模式
  console.log('[make-mobile-shots] 截取移动端深色模式...')
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }]
  })
  await sleep(600)
  const shotDark = await cdp.send('Page.captureScreenshot', { format: 'png' })
  saveShot('screenshot-mobile-dark.png', Buffer.from(shotDark.data, 'base64'))

  // 收尾退出
  ws.close()
  await chrome.close()
  await mock.close()
  await stat.close()
  console.log('[make-mobile-shots] 移动端截图全部完成！')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
