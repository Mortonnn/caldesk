/**
 * 生成 README 所需的高清真实桌面端截图：
 * 1. screenshot-desktop-light.png
 * 2. screenshot-desktop-dark.png
 * 3. screenshot-desktop-notes.png
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PUBLIC_DOCS = resolve(ROOT, '..', '..', 'caldesk-public', 'docs')
const LOCAL_DOCS = join(ROOT, 'docs')

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

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { ok, bad } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? bad(new Error(m.error.message)) : ok(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = (this.id += 1)
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((ok, bad) => this.pending.set(id, { ok, bad }))
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
  async viewport(width, height, dsf = 2) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dsf,
      mobile: false
    })
    await sleep(250)
  }
  async media(features) {
    await this.send('Emulation.setEmulatedMedia', {
      features: features.map((f) => ({ name: f.name, value: f.value }))
    })
    await sleep(300)
  }
  async click(selector) {
    const b = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
    })()`)
    if (!b || b.w <= 0) throw new Error(`找不到元素: ${selector}`)
    const base = { x: b.x, y: b.y, button: 'left', clickCount: 1 }
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
    await sleep(150)
  }
  async shot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }
}

async function main() {
  console.log('[make-readme-shots] 启动中...')
  const cdpPort = await freePort()
  const apiPort = await freePort()
  const userDataDir = join(tmpdir(), `caldesk-readme-shots-${Date.now()}`)

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.CALDESK_MCP_PORT = String(apiPort)

  const args = [
    '.',
    '--user-data',
    userDataDir,
    `--remote-debugging-port=${cdpPort}`,
    '--no-sandbox'
  ]

  const child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))

  let target = null
  let endpoint = cdpPort
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(log)
    if (m) endpoint = Number(m[1])
    try {
      const list = await (await fetch(`http://127.0.0.1:${endpoint}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (target?.webSocketDebuggerUrl) break
    } catch {
      // 等待服务就绪
    }
    await sleep(250)
  }

  if (!target) {
    child.kill('SIGKILL')
    throw new Error(`CDP 等待页面超时:\n${log}`)
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })

  const cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Log.enable')

  // 等待 UI 初始化稳定
  for (let i = 0; i < 60; i += 1) {
    const st = await cdp
      .eval(`({ grids: document.querySelectorAll('.grid').length, cals: document.querySelectorAll('.cal-item').length })`)
      .catch(() => ({ grids: 0, cals: 0 }))
    if (st.grids === 1 && st.cals > 0) break
    await sleep(200)
  }

  console.log('[make-readme-shots] UI 初始就绪，灌入占位示例数据...')

  // MCP 调用辅助
  const mcp = async (tool, toolArgs = {}) => {
    const res = await fetch(`http://127.0.0.1:${apiPort}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: toolArgs }
      })
    })
    const json = await res.json()
    if (json.error) throw new Error(json.error.message)
    return JSON.parse(json.result.content[0].text)
  }

  const cals = await mcp('calendar_list')
  const defaultCalId = cals[0]?.id

  // 1. 灌入通用示例待办（内容是占位串，README 截图里不出现任何具体事务）
  //    日期按「今天」推算，不能写死：写死的话换一天跑，选中的那天反而是空的。
  const pad = (n) => String(n).padStart(2, '0')
  const base = new Date()
  const dayOffset = (off) => {
    const d = new Date(base)
    d.setDate(d.getDate() + off)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  await mcp('items_set', {
    calendar_id: defaultCalId,
    date: dayOffset(0),
    text: '111\n221\n234\n~~测试~~'
  })

  await mcp('items_set', {
    calendar_id: defaultCalId,
    date: dayOffset(2),
    text: '测试一下\n再测试一下'
  })

  await mcp('items_set', {
    calendar_id: defaultCalId,
    date: dayOffset(4),
    text: '333\n444'
  })

  await mcp('items_set', {
    calendar_id: defaultCalId,
    date: dayOffset(6),
    text: '555'
  })

  await mcp('items_set', {
    calendar_id: defaultCalId,
    date: dayOffset(7),
    text: '666\n777'
  })

  await mcp('items_set', {
    calendar_id: defaultCalId,
    date: dayOffset(-4),
    text: '~~888~~'
  })

  await mcp('items_set', {
    calendar_id: defaultCalId,
    date: dayOffset(-2),
    text: '~~999~~'
  })

  // 2. 灌入事件：倒数日
  await mcp('event_create', {
    calendar_id: defaultCalId,
    title: '111',
    kind: 'countdown',
    start: dayOffset(0),
    target_date: dayOffset(12)
  })

  // 3. 灌入便签（同样只放占位串）
  await mcp('notes_create', {
    calendar_id: defaultCalId,
    title: '111',
    content: '111\n221\n234\n测试',
    pinned: true
  })

  await mcp('notes_create', {
    calendar_id: defaultCalId,
    title: '222',
    content: '333\n444\n555',
    pinned: true
  })

  await mcp('notes_create', {
    calendar_id: defaultCalId,
    title: '333',
    content: '666\n777\n888\n999',
    pinned: false
  })

  console.log('[make-readme-shots] 数据灌入完成，刷新并等待渲染...')
  await sleep(800)

  // 选中今天 2026-11-07
  await cdp.eval(`(() => {
    const todayCell = document.querySelector('.day-cell.today')
    if (todayCell) todayCell.click()
  })()`)
  await sleep(1200)

  mkdirSync(PUBLIC_DOCS, { recursive: true })
  mkdirSync(LOCAL_DOCS, { recursive: true })

  const saveShot = (filename, buf) => {
    writeFileSync(join(PUBLIC_DOCS, filename), buf)
    writeFileSync(join(LOCAL_DOCS, filename), buf)
    console.log(`[make-readme-shots] 已保存: ${filename} (${buf.length} bytes)`)
  }

  // 优雅视口：1240 x 800 @ 2x
  await cdp.viewport(1240, 800, 2)

  // 1. 浅色主题截图
  console.log('[make-readme-shots] 截取浅色主题...')
  await cdp.media([{ name: 'prefers-color-scheme', value: 'light' }])
  await sleep(500)
  const shotLight = await cdp.shot()
  saveShot('screenshot-desktop-light.png', shotLight)

  // 2. 深色主题截图
  console.log('[make-readme-shots] 截取深色主题...')
  await cdp.media([{ name: 'prefers-color-scheme', value: 'dark' }])
  await sleep(500)
  const shotDark = await cdp.shot()
  saveShot('screenshot-desktop-dark.png', shotDark)

  // 3. 便签侧边栏截图
  console.log('[make-readme-shots] 截取便签视图...')
  await cdp.media([{ name: 'prefers-color-scheme', value: 'light' }])
  await sleep(300)
  // 先关闭右侧详情栏（点详情栏的关闭按钮），使背景月历更加纯净展开
  await cdp.eval(`(() => {
    const closeBtn = document.querySelector('.detail-head button.ghost')
    if (closeBtn) closeBtn.click()
  })()`)
  await sleep(1200)
  await cdp.click('button[aria-label="便签"]')
  await sleep(600) // 等待展开动画完毕
  const shotNotes = await cdp.shot()
  saveShot('screenshot-desktop-notes.png', shotNotes)

  console.log('[make-readme-shots] 所有桌面端截图截取完成，正在收尾...')
  ws.close()
  child.kill('SIGTERM')
  await sleep(1000)
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // 忽略临时文件锁
  }
  console.log('[make-readme-shots] 完成！')
}

main().catch((err) => {
  console.error('[make-readme-shots] 失败:', err)
  process.exit(1)
})
