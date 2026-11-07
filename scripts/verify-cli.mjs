#!/usr/bin/env node
/**
 * verify-cli — cal 命令行验收脚本。
 *
 * 自带启停：构建 → 用 --user-data 起一个隔离实例 → 用 CALDESK_RUNTIME 指过去跑 CLI → 杀进程。
 *
 * 用法：
 *   node scripts/verify-cli.mjs               # 默认先 npm run build
 *   node scripts/verify-cli.mjs --no-build    # 跳过构建
 *   node scripts/verify-cli.mjs --keep        # 保留临时数据目录
 *   node scripts/verify-cli.mjs --port 19360  # 指定端口
 *
 * 退出码：0 全通过；1 有失败；2 环境问题。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CAL = join(ROOT, 'bin', 'cal.mjs')
const argv = process.argv.slice(2)
const NO_BUILD = argv.includes('--no-build') || process.env.CALDESK_SKIP_BUILD === '1'
const KEEP = argv.includes('--keep')
const portArg = argv.indexOf('--port')
const FIXED_PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 0

/* ------------------------------ 断言框架 ------------------------------ */

let pass = 0
let fatal = false
const failures = []
let groupPass = 0
let groupName = ''

function flushGroup() {
  if (groupName) {
    console.log(`   ${groupName}: ${groupPass} 通过`)
    groupName = ''
    groupPass = 0
  }
}

function group(name) {
  flushGroup()
  groupName = name
  groupPass = 0
  console.log(`\n▶ ${name}`)
}

function assert(name, cond, detail = '') {
  if (cond) {
    pass += 1
    groupPass += 1
    return true
  }
  failures.push({ group: groupName, name, detail })
  console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).replace(/\n/g, '\n      ')}` : ''}`)
  return false
}

/** 单个断言组抛异常时不要让整轮跑挂：记一条失败，继续下一组 */
async function runSuite(label, fn) {
  try {
    await fn()
  } catch (err) {
    flushGroup()
    assert(`${label} 未跑完（脚本异常）`, false, err?.stack ?? String(err))
    flushGroup()
  }
}

/* ------------------------------ 实例管理 ------------------------------ */

function electronBinary() {
  const require_ = createRequire(import.meta.url)
  try {
    const p = require_('electron')
    if (typeof p === 'string' && existsSync(p)) return p
  } catch {
    /* 兜底路径 */
  }
  const rel = process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe'
    : process.platform === 'darwin' ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      : 'node_modules/electron/dist/electron'
  const abs = join(ROOT, rel)
  return existsSync(abs) ? abs : null
}

function buildIfNeeded() {
  const entry = join(ROOT, 'out', 'main', 'index.js')
  if (NO_BUILD) {
    if (!existsSync(entry)) throw new Error('out/main/index.js 不存在，请先 npm run build（或去掉 --no-build）')
    console.log('· 跳过构建（--no-build）')
    return
  }
  console.log('· 构建中：npm run build')
  const res = spawnSync('npm run build', { cwd: ROOT, shell: true, encoding: 'utf-8' })
  if (res.status !== 0) {
    console.error(res.stdout?.slice(-2000))
    console.error(res.stderr?.slice(-2000))
    throw new Error(`npm run build 失败（exit ${res.status}）`)
  }
  console.log('· 构建完成')
}

function freePort() {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createNetServer()
    srv.unref()
    srv.on('error', rejectFn)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolveFn(p))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealth(port, timeoutMs = 40000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // 校验 body 里的 app 字段，避免端口上恰好是别的服务就误判成功
    const ok = await new Promise((resolveFn) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'GET', path: '/health', timeout: 1000 },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (d) => {
            body += d
          })
          res.on('end', () => {
            try {
              resolveFn(res.statusCode === 200 && JSON.parse(body).app === 'caldesk')
            } catch {
              resolveFn(false)
            }
          })
        }
      )
      req.on('timeout', () => {
        req.destroy()
        resolveFn(false)
      })
      req.on('error', () => resolveFn(false))
      req.end()
    })
    if (ok) return true
    await sleep(250)
  }
  return false
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

async function startInstance({ userDataDir, port, logFile }) {
  const exe = electronBinary()
  if (!exe) throw new Error('找不到 electron 可执行文件')
  mkdirSync(userDataDir, { recursive: true })
  const env = { ...process.env, CALDESK_MCP_PORT: String(port) }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  const fd = openSync(logFile, 'a')
  const child = spawn(exe, ['.', `--user-data=${userDataDir}`], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const chunks = []
  const collect = (d) => {
    if (chunks.length < 200) chunks.push(d.toString())
    try {
      writeSync(fd, d)
    } catch {
      /* 忽略 */
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  if (!(await waitHealth(port))) {
    killTree(child)
    throw new Error(`隔离实例没有在 ${port} 端口起来：\n${chunks.slice(-30).join('')}`)
  }
  return child
}

/* ------------------------------ CLI 调用 ------------------------------ */

let runtimeFile = ''
let port = 0

function cli(args, { runtime = runtimeFile, url = null, json = false, timeout = 30000 } = {}) {
  const env = { ...process.env }
  delete env.CALDESK_URL
  delete env.CALDESK_TOKEN
  delete env.CALDESK_RUNTIME
  if (runtime !== null) env.CALDESK_RUNTIME = runtime
  const full = [...args]
  if (url) full.push('--url', url)
  if (json) full.push('--json')
  const res = spawnSync(process.execPath, [CAL, ...full], {
    env,
    encoding: 'utf-8',
    timeout
  })
  return {
    status: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim()
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/* ------------------------------ 主流程 ------------------------------ */

let child = null
let userDataDir = ''

async function main() {
  buildIfNeeded()
  port = FIXED_PORT || (await freePort())
  userDataDir = join(tmpdir(), `caldesk-verify-cli-${randomUUID().slice(0, 8)}`)
  console.log(`· 隔离实例端口 ${port}，数据目录 ${userDataDir}`)
  child = await startInstance({ userDataDir, port, logFile: join(userDataDir, 'electron.log') })
  runtimeFile = join(userDataDir, 'runtime.json')

  await runSuite('端口发现', discoverySuite)
  await runSuite('子命令基础', subcommandSuite)
  await runSuite('JSON 输出', jsonSuite)
  await runSuite('用法错误', usageErrorSuite)
  await runSuite('回归', regressionSuite)
  flushGroup()

  console.log(`\n${'─'.repeat(56)}`)
  if (failures.length === 0) console.log(`全部通过：${pass} 项断言`)
  else {
    console.log(`失败 ${failures.length} 项 / 通过 ${pass} 项`)
    for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name}`)
  }
}

/* 1. 端口自动发现 */
async function discoverySuite() {
  group('端口发现：runtime.json / CALDESK_URL / --url')

  const runtime = parseJson(readFileSync(runtimeFile, 'utf-8'))
  assert('runtime.json 里有 port 字段', typeof runtime?.port === 'number', JSON.stringify(runtime))

  const viaRuntime = cli(['list'])
  assert('只靠 CALDESK_RUNTIME 就能找到服务', viaRuntime.status === 0, viaRuntime.stderr)
  assert('cal list 输出 JSON 视图数组', Array.isArray(parseJson(viaRuntime.stdout)), viaRuntime.stdout.slice(0, 200))

  const viaUrl = cli(['list', '--url', `http://127.0.0.1:${port}`])
  assert('--url 覆盖自动发现', viaUrl.status === 0, viaUrl.stderr)

  // CALDESK_URL 只有桥读，CLI 不读；这里确认 CLI 在 runtime 缺失时会提示
  const missing = cli(['list'], { runtime: join(userDataDir, 'nope.json') })
  assert('runtime.json 缺失 → 退出码 1', missing.status === 1, `exit ${missing.status}`)
  assert('runtime.json 缺失 → 提示启动桌面端', /找不到 caldesk 的运行信息/.test(missing.stderr), missing.stderr)

  const missingJson = cli(['list', '--json'], { runtime: join(userDataDir, 'nope.json') })
  const missingPayload = parseJson(missingJson.stdout)
  assert(
    '--json 模式下的「找不到运行信息」也是 JSON',
    missingJson.status === 1 && missingPayload?.ok === false && typeof missingPayload.error?.message === 'string',
    `stdout=${missingJson.stdout}\nstderr=${missingJson.stderr}`
  )

  // 端口不对（服务没在跑）
  const deadPortFile = join(userDataDir, 'dead-runtime.json')
  writeFileSync(deadPortFile, JSON.stringify({ port: 1, pid: 0, startedAt: 0 }))
  const dead = cli(['list'], { runtime: deadPortFile })
  assert('端口不通 → 退出码 1', dead.status === 1, `exit ${dead.status}`)
  assert('端口不通 → 提示连接失败', /连接 caldesk 失败/.test(dead.stderr), dead.stderr)
}

/* 2. 子命令正常路径 */
async function subcommandSuite() {
  group('子命令：list / add / day / done / undone / rm')

  const date = '2033-01-05'
  const add = cli(['add', date, '买牛奶'])
  assert('cal add 成功', add.status === 0, add.stderr)
  assert('cal add 有回显', /已添加到 2033-01-05/.test(add.stdout), add.stdout)

  const day = cli(['day', date])
  assert('cal day 列出该行', day.status === 0 && /买牛奶/.test(day.stdout), day.stdout)
  assert('cal day 带行号 0', /^\s*0\s/.test(day.stdout), JSON.stringify(day.stdout))

  const dayJson = parseJson(cli(['day', date, '--json']).stdout)
  assert('cal day --json 输出结构化日格', Array.isArray(dayJson?.lines) && dayJson.lines[0] === '买牛奶', JSON.stringify(dayJson))

  const done = cli(['done', date, '0'])
  assert('cal done 成功', done.status === 0 && /已完成/.test(done.stdout), done.stderr)
  const afterDone = parseJson(cli(['day', date, '--json']).stdout)
  assert('cal done 把该行写成 ~~文本~~', afterDone?.lines?.[0] === '~~买牛奶~~', JSON.stringify(afterDone))

  const undone = cli(['undone', date, '0'])
  assert('cal undone 成功', undone.status === 0 && /取消完成/.test(undone.stdout), undone.stderr)
  const afterUndone = parseJson(cli(['day', date, '--json']).stdout)
  assert('cal undone 去掉删除线', afterUndone?.lines?.[0] === '买牛奶', JSON.stringify(afterUndone))

  const rm = cli(['rm', date, '0'])
  assert('cal rm 成功', rm.status === 0 && /已删除/.test(rm.stdout), rm.stderr)
  const afterRm = parseJson(cli(['day', date, '--json']).stdout)
  assert('cal rm 后该行为空', (afterRm?.lines ?? []).length === 0, JSON.stringify(afterRm))

  const emptyDay = cli(['day', '2033-01-06'])
  assert('cal day 空日输出「没有任务」', /没有任务/.test(emptyDay.stdout), emptyDay.stdout)

  group('子命令：new-event / events / del-event / search')

  const created = cli(['new-event', '周会', '--kind', 'task', '--start', '2033-02-07', '--rrule', 'FREQ=WEEKLY;BYDAY=MO'])
  const createdJson = parseJson(created.stdout)
  assert('cal new-event 成功', created.status === 0 && typeof createdJson?.id === 'string', created.stderr || created.stdout)
  assert('cal new-event 保存 rrule', createdJson?.rrule === 'FREQ=WEEKLY;BYDAY=MO', JSON.stringify(createdJson))

  const events = cli(['events', '--from', '2033-02-01', '--to', '2033-02-28'])
  assert('cal events 列出事件', events.status === 0 && /周会/.test(events.stdout), events.stderr || events.stdout)

  const eventsJson = parseJson(cli(['events', '--from', '2033-02-01', '--to', '2033-02-28', '--json']).stdout)
  assert('cal events --json 输出数组', Array.isArray(eventsJson) && eventsJson.length >= 1, JSON.stringify(eventsJson)?.slice(0, 300))
  assert('cal events --json 带视图名', typeof eventsJson?.[0]?.calendar === 'string', JSON.stringify(eventsJson?.[0]))

  const kindTask = cli(['events', '--from', '2033-02-01', '--to', '2033-02-28', '--kind', 'task', '--json'])
  const kindTaskJson = parseJson(kindTask.stdout)
  assert('cal events --kind task 过滤生效', Array.isArray(kindTaskJson) && kindTaskJson.every((e) => e.kind === 'task'), kindTask.stdout.slice(0, 300))

  const noEvents = cli(['events', '--from', '2035-01-06', '--to', '2035-01-07'])
  assert('cal events 空区间提示「没有事件」', /没有事件/.test(noEvents.stdout), noEvents.stdout)

  const delEvent = createdJson?.id ? cli(['del-event', createdJson.id]) : { status: -1, stdout: '', stderr: '上一步没拿到 id' }
  assert('cal del-event 成功', delEvent.status === 0 && /已删除事件/.test(delEvent.stdout), delEvent.stderr)

  // search
  cli(['add', '2033-03-01', '独特检索词XYZ'])
  cli(['new-event', '独特检索词XYZ 事件', '--kind', 'task', '--start', '2033-03-02'])
  const search = cli(['search', '独特检索词XYZ'])
  assert('cal search 命中任务与事件', search.status === 0 && /任务|独特检索词/.test(search.stdout), search.stderr || search.stdout)
  const searchJson = parseJson(cli(['search', '独特检索词XYZ', '--json']).stdout)
  assert('cal search --json 输出数组', Array.isArray(searchJson) && searchJson.length >= 2, JSON.stringify(searchJson)?.slice(0, 300))
  const searchNone = cli(['search', '绝对不存在的词ZZZ'])
  assert('cal search 无结果时提示', /没有匹配结果/.test(searchNone.stdout), searchNone.stdout)
}

/* 3. --json 一致性 */
async function jsonSuite() {
  group('--json：成功与失败都输出可解析 JSON')

  const okRun = cli(['list', '--json'])
  assert('成功时 stdout 是合法 JSON', parseJson(okRun.stdout) !== null, okRun.stdout.slice(0, 200))
  assert('成功时退出码 0', okRun.status === 0, `exit ${okRun.status}`)

  const badDate = cli(['day', '2033-13-40', '--json'])
  const badPayload = parseJson(badDate.stdout)
  assert('非法日期：退出码 1', badDate.status === 1, `exit ${badDate.status}`)
  assert('非法日期：--json 输出 {ok:false,error.message}', badPayload?.ok === false && typeof badPayload.error?.message === 'string', `stdout=${badDate.stdout}`)
  assert('非法日期：--json 模式不再往 stderr 打中文提示', badDate.stderr === '', `stderr=${badDate.stderr}`)

  const missingId = cli(['del-event', 'no-such-id', '--json'])
  assert('运行期错误同样以 JSON 返回', parseJson(missingId.stdout)?.ok === false, `stdout=${missingId.stdout} exit=${missingId.status}`)

  const addJson = cli(['add', '2033-04-01', 'json 模式任务', '--json'])
  const addPayload = parseJson(addJson.stdout)
  assert('写操作 --json 返回日格结构', Array.isArray(addPayload?.lines) && addPayload.lines[0] === 'json 模式任务', addJson.stdout)
}

/* 4. 用法错误 */
async function usageErrorSuite() {
  group('用法：帮助 / 未知子命令 / 缺参数')

  const noArgs = cli([])
  assert('无参数：打印用法且退出码 0', noArgs.status === 0 && /cal — caldesk 命令行客户端/.test(noArgs.stdout), `exit=${noArgs.status}`)

  const help = cli(['--help'])
  assert('--help 退出码 0 且有用法', help.status === 0 && /全局选项/.test(help.stdout), `exit=${help.status}\n${help.stdout.slice(0, 200)}`)
  const helpShort = cli(['-h'])
  assert('-h 与 --help 等价', helpShort.status === 0 && /cal list/.test(helpShort.stdout), `exit=${helpShort.status}`)

  const unknown = cli(['frobnicate'])
  assert('未知子命令：退出码 2', unknown.status === 2, `exit ${unknown.status}`)
  assert('未知子命令：提示「未知子命令」', /未知子命令/.test(unknown.stderr), unknown.stderr)
  assert('未知子命令：同时给出用法', /用法|cal list/.test(unknown.stdout + unknown.stderr), (unknown.stdout + unknown.stderr).slice(0, 200))

  const cases = [
    { args: ['add', '2033-05-01'], name: 'add 缺文本' },
    { args: ['add'], name: 'add 完全没参数' },
    { args: ['done', '2033-05-01'], name: 'done 缺行号' },
    { args: ['rm', '2033-05-01'], name: 'rm 缺行号' },
    { args: ['del-event'], name: 'del-event 缺 id' },
    { args: ['new-event'], name: 'new-event 缺标题' },
    { args: ['search'], name: 'search 缺关键词' },
    { args: ['events', '--from'], name: 'events 的 --from 缺值' }
  ]
  for (const c of cases) {
    const r = cli(c.args)
    assert(`${c.name} → 退出码 2`, r.status === 2, `exit ${r.status}\n${r.stderr}`)
  }

  const badIndex = cli(['done', '2033-05-01', 'abc'])
  assert('行号非数字 → 退出码 2（不再静默改第 0 行）', badIndex.status === 2, `exit ${badIndex.status}\n${badIndex.stderr}`)
  const negIndex = cli(['rm', '2033-05-01', '-1'])
  assert('行号为负 → 退出码 2', negIndex.status === 2, `exit ${negIndex.status}\n${negIndex.stderr}`)

  const badKind = cli(['events', '--kind', 'bogus'])
  assert('events --kind 非法 → 退出码 2', badKind.status === 2, `exit ${badKind.status}\n${badKind.stderr}`)

  const badDate = cli(['day', 'not-a-date'])
  assert('非法日期 → 退出码 1（服务端校验）', badDate.status === 1, `exit ${badDate.status}`)
}

/* 5. 回归：曾经会误改第 0 行的坑 */
async function regressionSuite() {
  group('回归：非法行号不能动到第 0 行')

  const date = '2033-06-01'
  cli(['add', date, '不能被误改'])
  cli(['add', date, '第二行'])

  const before = parseJson(cli(['day', date, '--json']).stdout)
  assert('准备两行数据', before?.lines?.length === 2, JSON.stringify(before))

  for (const bad of ['abc', '', '-1', '1.5', 'nan']) {
    const r = cli(['done', date, bad])
    assert(`done 传「${bad}」被拒（exit 2）`, r.status === 2, `exit ${r.status}`)
  }
  const after = parseJson(cli(['day', date, '--json']).stdout)
  assert('多次非法行号后数据未被改动', JSON.stringify(after) === JSON.stringify(before), `before=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`)

  const outOfRange = cli(['done', date, '99'])
  assert('行号越界 → exit 1 且带范围提示', outOfRange.status === 1 && /超出范围/.test(outOfRange.stderr), `exit ${outOfRange.status}\n${outOfRange.stderr}`)
}

/* ------------------------------ 入口 ------------------------------ */

main()
  .catch((err) => {
    console.error(`\n[verify-cli] 执行失败：${err?.message ?? err}`)
    fatal = true
    process.exitCode = 2
  })
  .finally(async () => {
    if (child) killTree(child)
    await sleep(600) // 给 Electron 的子进程一点退出时间，否则 Windows 上目录还被占用
    if (KEEP) console.log(`· 保留临时目录：${userDataDir}`)
    else if (userDataDir) {
      for (let i = 0; i < 5; i += 1) {
        try {
          rmSync(userDataDir, { recursive: true, force: true })
          break
        } catch {
          await sleep(400)
        }
      }
    }
    if (fatal) console.log('\n❌ verify-cli 未跑完（环境问题，见上面的错误）')
    else console.log(failures.length === 0 ? '\n✅ verify-cli 全部通过' : `\n❌ verify-cli 有 ${failures.length} 项失败`)
    process.exit(fatal ? 2 : failures.length === 0 ? 0 : 1)
  })
