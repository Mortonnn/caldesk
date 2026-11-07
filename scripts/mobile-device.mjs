/**
 * 安卓真机验证（WebView + 硬件返回键 + 安全区 + 键盘 + 暗色）。
 *
 * 前置：
 *   adb devices                     # 有一台已授权设备
 *   npm run build:mobile && npx cap sync android
 *   cd android && gradlew assembleDebug
 *   adb install -r app/build/outputs/apk/debug/app-debug.apk
 *
 * 用法：
 *   node scripts/mobile-device.mjs                 # 连当前设备跑
 *   node scripts/mobile-device.mjs --keep-data     # 不清 localStorage
 *
 * 退出码：0 = 全过；1 = 有断言失败；2 = 环境/脚本异常。
 * 截图落在 notes/test-reports/shots-mobile/dev-*.png。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startMock } from './mobile-mock-worker.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SHOTS = join(ROOT, 'notes', 'test-reports', 'shots-mobile')
const PKG = 'app.caldesk.mobile'
const ACTIVITY = `${PKG}/.MainActivity`
const MOCK_PORT = 8788
const DEVTOOLS_PORT = 9222
const SERVER = `http://127.0.0.1:${MOCK_PORT}`

const results = []
let suiteName = ''
function suite(n) {
  suiteName = n
  console.log(`\n── ${n} ─────────────────────────────`)
}
function check(name, ok, detail = '') {
  results.push({ suite: suiteName, name, ok: Boolean(ok), detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  · ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function adb(...args) {
  return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).toString()
}
function adbBuf(...args) {
  return execFileSync('adb', args, { maxBuffer: 64 * 1024 * 1024 })
}
async function shot(name) {
  writeFileSync(join(SHOTS, `${name}.png`), adbBuf('exec-out', 'screencap', '-p'))
}
function focusedApp() {
  try {
    const out = adb('shell', 'dumpsys', 'window')
    const m = /mCurrentFocus=Window\{[^}]*?(\S+\/\S+)\}/.exec(out)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}
function appAlive() {
  return focusedApp().includes(PKG)
}
function pressBackKey() {
  adb('shell', 'input', 'keyevent', '4')
}
async function startApp() {
  adb('shell', 'am', 'start', '-n', ACTIVITY)
  await sleep(1600)
}

/* ------------------------------ CDP ------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      if (msg.id === undefined) return
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
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
      }, 20000)
    })
  }
}

async function connectPage() {
  const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).json()
  const target = list.find((t) => t.type === 'page' && t.url.startsWith('https://localhost'))
  if (!target) throw new Error('没找到 WebView 页面（应用是不是没在前台？）')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('连不上 WebView devtools')), { once: true })
  })
  return new CDP(ws)
}

/** 起应用 + 找到（可能换了 pid 的）devtools socket + 连上 */
async function attach({ restart = false } = {}) {
  if (restart) {
    adb('shell', 'am', 'force-stop', PKG)
    await sleep(900)
  }
  await startApp()
  let sock = ''
  for (let i = 0; i < 12 && !sock; i += 1) {
    const unix = adb('shell', 'cat', '/proc/net/unix')
    sock = /@(webview_devtools_remote_\d+)/.exec(unix)?.[1] ?? ''
    if (!sock) await sleep(400)
  }
  if (!sock) throw new Error('WebView devtools 没开（debug 包才会开）')
  adb('forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:${sock}`)
  await sleep(300)
  const c = await connectPage()
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  return c
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  }
  return r.result?.value
}

const q = (s) => `document.querySelector(${JSON.stringify(s)})`
const qAll = (s) => `[...document.querySelectorAll(${JSON.stringify(s)})]`
const has = async (c, s) => evaluate(c, `return !!${q(s)}`)
const count = async (c, s) => evaluate(c, `return ${qAll(s)}.length`)
const textOf = async (c, s) =>
  evaluate(c, `const el = ${q(s)}; return el ? (el.innerText || '').trim() : null`)

async function waitFor(cdp, sel, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      if (await has(cdp, sel)) return Date.now() - start
    } catch {
      /* 页面正在刷新 */
    }
    await sleep(150)
  }
  return -1
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  mkdirSync(SHOTS, { recursive: true })
  const keepData = process.argv.includes('--keep-data')

  const devices = adb('devices')
  const attached = devices.split('\n').find((l) => /\tdevice\b/.test(l))
  if (!attached) {
    console.error(devices)
    throw new Error('没有已授权的安卓设备')
  }
  console.log('设备：', attached.trim())

  /* 假 Worker + adb reverse：让手机上的 127.0.0.1:8788 打到这台电脑 */
  const mock = await startMock({ port: MOCK_PORT })
  adb('reverse', `tcp:${MOCK_PORT}`, `tcp:${MOCK_PORT}`)

  let cdp = await attach()

  /* 种账号 + 数据（和真实登录写进去的是同一份形状） */
  const today = await evaluate(
    cdp,
    `const d = new Date();
     return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')`
  )
  await fetch(`${SERVER}/__mock/reset`, { method: 'POST' })
  const seed = await (
    await fetch(`${SERVER}/__mock/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'alice',
        password: 'Passw0rd!x',
        calendars: [
          { id: 'cal-work', name: '工作', color: '#7c8cff' },
          { id: 'cal-life', name: '生活', color: '#43c59e' }
        ],
        cells: [{ calendarId: 'cal-work', date: today, text: '真机上的任务\n~~做完了~~\n第三行' }],
        events: [
          {
            id: 'evt-w',
            calendarId: 'cal-work',
            kind: 'task',
            title: '每周复盘',
            start: today,
            rrule: 'FREQ=WEEKLY'
          }
        ]
      })
    })
  ).json()
  if (!seed.accountId) throw new Error('seed 失败')

  // 这个脚本跑在**真机**上，会覆盖用户自己的登录身份。先备份，跑完再还原；
  // 否则手机上会永远留着 alice@127.0.0.1 这个测试账号（设备名也会变成「真机验收」）。
  const prevIdentity = await evaluate(cdp, `return localStorage.getItem('caldesk.identity')`)

  if (!keepData) {
    await evaluate(cdp, `try { localStorage.clear() } catch (e) {}; return true`)
  }
  const login = await evaluate(
    cdp,
    `const deviceId = 'dev-' + Math.random().toString(36).slice(2, 10);
     // secret 必须是 32 字节 / 64 位 hex —— 服务端只认这个长度。
     // 以前这里写 24 字节（48 位），线上 Worker 一律回「secret 必须是 64 位 hex」。
     const deviceSecret = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2,'0')).join('');
     const r = await fetch(${JSON.stringify(SERVER + '/auth/login')}, {
       method: 'POST', headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ username: 'alice', password: 'Passw0rd!x', deviceId, secret: deviceSecret, deviceName: '真机验收' })
     });
     if (!r.ok) return { ok: false, status: r.status, body: await r.text() };
     const j = await r.json();
     localStorage.setItem('caldesk.identity', JSON.stringify({
       accountId: j.accountId, deviceId, deviceSecret, deviceName: '真机验收',
       serverUrl: ${JSON.stringify(SERVER)}, username: 'alice'
     }));
     return { ok: true, accountId: j.accountId }`
  )
  if (!login?.ok) throw new Error(`登录失败：${JSON.stringify(login)}`)

  await cdp.send('Page.reload')
  await sleep(600)
  const gridWaited = await waitFor(cdp, '.m-grid-cell')
  check('真机冷启动画出月历', gridWaited >= 0, `${gridWaited}ms`)
  check('真机没有停在登录页', !(await has(cdp, '.m-setup')))
  await sleep(1400)
  check('42 格月历（真机 WebView）', (await count(cdp, '.m-pane:nth-child(2) .m-grid-cell')) === 42)
  check('当天待办渲染出来（3 行 + 1 条重复待办）', (await count(cdp, '.m-task')) >= 4, `${await count(cdp, '.m-task')} 行`)
  check('真机首屏没有白屏（有顶栏标题）', Boolean(await textOf(cdp, '.m-top-month')))
  await shot('dev-10-home-light')

  suite('真机：WebView 环境能力')

  const env = await evaluate(
    cdp,
    `const root = document.documentElement;
     const dock = document.querySelector('.m-dock-wrap');
     const top = document.querySelector('.m-top');
     const probe = document.createElement('div');
     probe.style.paddingBottom = 'env(safe-area-inset-bottom, 0px)';
     probe.style.paddingTop = 'env(safe-area-inset-top, 0px)';
     document.body.appendChild(probe);
     const cs = getComputedStyle(probe);
     const envBottom = cs.paddingBottom, envTop = cs.paddingTop;
     probe.remove();
     return {
       mat: root.dataset.mat, glass: root.dataset.glass,
       envTop, envBottom,
       dockPadBottom: dock ? getComputedStyle(dock).paddingBottom : null,
       topPadTop: top ? getComputedStyle(top).paddingTop : null,
       canVibrate: typeof navigator.vibrate === 'function',
       dpr: window.devicePixelRatio, vw: innerWidth, vh: innerHeight,
       supportsBackdrop: CSS.supports('backdrop-filter', 'blur(4px)')
     }`
  )
  console.log('   环境：', JSON.stringify(env))
  check(
    '安全区 env() 在真机上不是 0（刘海/手势条）',
    env.envBottom !== '0px' || env.envTop !== '0px',
    `${env.envTop}/${env.envBottom}`
  )
  check('顶栏吃到了顶部安全区', parseFloat(env.topPadTop || '0') >= parseFloat(env.envTop || '0'), `topPadding=${env.topPadTop}`)
  check('底栏给手势条留了位置', parseFloat(env.dockPadBottom || '0') > 12, `dockPadding=${env.dockPadBottom}`)
  check('navigator.vibrate 可用（底栏跨格轻震）', env.canVibrate === true)
  check('没有横向溢出', await evaluate(cdp, `return document.documentElement.scrollWidth <= innerWidth + 1`))

  suite('真机：硬件返回键')

  /* 真正重启一次：WebView 历史要干净，断言才可信 */
  cdp = await attach({ restart: true })
  await sleep(1500)
  const histBoot = await evaluate(cdp, `return { len: history.length, state: history.state }`)
  check(
    '冷启动时历史里没有残留的弹层记录',
    !(histBoot.state && histBoot.state.caldeskOverlay),
    JSON.stringify(histBoot)
  )

  /*
   * 弹层打开时输入框会自动聚焦、键盘弹起，所以返回键第一次是"收键盘"（系统行为），
   * 第二次才是"关弹层"。真实用户看到的就是这个顺序，测试就照这个顺序打。
   */
  await evaluate(cdp, `document.querySelector('.m-fab').click(); return true`)
  await sleep(900)
  check('弹层在真机上打开', await has(cdp, '.m-sheet.is-open'))
  const histOpen = await evaluate(cdp, `return { len: history.length, state: history.state }`)
  check('弹层打开时历史里压了一层', Boolean(histOpen.state && histOpen.state.caldeskOverlay), JSON.stringify(histOpen))
  await shot('dev-11-sheet')

  pressBackKey()
  await sleep(1200)
  check('第一次返回：应用还在（收键盘 / 关弹层都不会退出）', appAlive(), `焦点=${focusedApp()}`)

  pressBackKey()
  await sleep(1400)
  const aliveAfterSheet = appAlive()
  const sheetStillOpen = await has(cdp, '.m-sheet.is-open').catch(() => false)
  check('硬件返回后应用还在前台（没被 finish）', aliveAfterSheet, `焦点=${focusedApp()}`)
  check('硬件返回关掉了弹层', !sheetStillOpen)
  const histClosed = await evaluate(cdp, `return { len: history.length, state: history.state }`).catch(() => null)
  check(
    '关掉弹层后历史状态回到干净态',
    !histClosed || !(histClosed.state && histClosed.state.caldeskOverlay),
    JSON.stringify(histClosed)
  )
  await shot('dev-12-after-back')

  if (!aliveAfterSheet) {
    console.log('   ↳ 应用被返回键退掉了，重新拉起来继续跑后面的用例')
    cdp = await attach({ restart: true })
    await sleep(1200)
  }

  /* 设置页按返回：回日历页，不退出 */
  await evaluate(cdp, `document.querySelector('.m-sheet-mask').click(); return true`)
  await sleep(400)
  await evaluate(
    cdp,
    `const it = ${qAll('.m-dock-item')}.find((x) => x.textContent.includes('设置')); it && it.click(); return true`
  )
  await sleep(800)
  const onSettings = (await textOf(cdp, '.m-top-month')) === '设置'
  check('进到设置页', onSettings)
  pressBackKey()
  await sleep(1500)
  const aliveAfterSettings = appAlive()
  const titleAfterSettings = aliveAfterSettings
    ? await textOf(cdp, '.m-top-month').catch(() => null)
    : null
  check(
    '设置页按返回 → 回日历页且不退出',
    onSettings && aliveAfterSettings && titleAfterSettings !== '设置',
    `还在前台=${aliveAfterSettings} 标题=${titleAfterSettings}`
  )
  await shot('dev-13-settings')

  if (!aliveAfterSettings) {
    console.log('   ↳ 应用被返回键退掉了，重新拉起来')
    cdp = await attach({ restart: true })
    await sleep(1200)
  }

  suite('真机：键盘 / 弹层位置')
  await evaluate(cdp, `document.querySelector('.m-fab').click(); return true`)
  await sleep(600)
  await evaluate(cdp, `const el = document.querySelector('.m-sheet-input'); el && el.focus(); return true`)
  await sleep(1400)
  const kb = await evaluate(
    cdp,
    `const sheet = document.querySelector('.m-sheet');
     const r = sheet.getBoundingClientRect();
     return { vh: innerHeight, sheetBottom: Math.round(r.bottom), sheetTop: Math.round(r.top),
              active: document.activeElement && document.activeElement.className }`
  )
  console.log('   键盘弹起：', JSON.stringify(kb))
  check('键盘弹起后弹层仍在可视区内', kb.sheetBottom <= kb.vh + 1 && kb.sheetTop >= 0, JSON.stringify(kb))
  await shot('dev-14-keyboard')
  pressBackKey()
  await sleep(900)
  check('键盘弹起时按返回只收键盘（弹层还在、应用还在）', (await has(cdp, '.m-sheet.is-open').catch(() => false)) && appAlive())
  await evaluate(cdp, `document.querySelector('.m-sheet-mask')?.click(); return true`)
  await sleep(500)

  suite('真机：暗色主题')
  if (!appAlive()) {
    cdp = await attach({ restart: true })
    await sleep(1200)
  }
  adb('shell', 'cmd', 'uimode', 'night', 'yes')
  await sleep(1400)
  const darkBg = await evaluate(cdp, `return getComputedStyle(document.getElementById('root')).backgroundColor`)
  check('系统切深色 → 应用跟着变深', darkBg !== 'rgb(238, 241, 245)' && Boolean(darkBg), darkBg)
  await shot('dev-15-home-dark')
  adb('shell', 'cmd', 'uimode', 'night', 'no')
  await sleep(1000)
  const lightBg = await evaluate(cdp, `return getComputedStyle(document.getElementById('root')).backgroundColor`)
  check('系统切回浅色 → 应用跟着变浅', lightBg !== darkBg, lightBg)

  suite('真机：日志')
  const logs = adb('logcat', '-d', '-t', '500')
  const errors = logs
    .split('\n')
    .filter((l) => /chromium|Capacitor/i.test(l) && /Uncaught|ERROR/.test(l))
    .filter((l) => !/crash|SIGSEGV/i.test(l))
  check('logcat 里没有 JS 未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '))

  /* 汇总 */
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${'='.repeat(64)}`)
  console.log(`真机断言 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
  for (const f of failed) console.log(`  ❌ [${f.suite}] ${f.name}${f.detail ? ` · ${f.detail}` : ''}`)
  console.log(`截图：${SHOTS}`)

  try {
    adb('forward', '--remove', `tcp:${DEVTOOLS_PORT}`)
    adb('reverse', '--remove', `tcp:${MOCK_PORT}`)
  } catch {
    /* ignore */
  }
  await mock.close()

  // 把真机原来的登录身份放回去；本来就没有就删掉测试身份。
  // 没有这一步的话，跑过一次验收，用户手机上就永久变成 alice + 「真机验收」。
  try {
    await evaluate(
      cdp,
      prevIdentity
        ? `localStorage.setItem('caldesk.identity', ${JSON.stringify(prevIdentity)}); return true`
        : `localStorage.removeItem('caldesk.identity'); return true`
    )
    await cdp.send('Page.reload')
    await sleep(500)
  } catch {
    /* 真机中途断开就跳过还原 */
  }

  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('\n真机验证异常：', err)
  process.exit(2)
})
