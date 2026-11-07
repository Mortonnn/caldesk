#!/usr/bin/env node
/**
 * verify-mcp — MCP 服务（JSON-RPC over HTTP）验收脚本。
 *
 * 自带启停：构建 → 用 --user-data 起一个隔离实例（不碰真实数据）→ 跑断言 → 杀进程。
 *
 * 用法：
 *   node scripts/verify-mcp.mjs               # 默认先 npm run build
 *   node scripts/verify-mcp.mjs --no-build    # 跳过构建（复用 out/）
 *   node scripts/verify-mcp.mjs --keep        # 保留临时数据目录，便于排查
 *   node scripts/verify-mcp.mjs --port 19350  # 指定端口（默认自动挑空闲端口）
 *
 * 覆盖：JSON-RPC 协议层 / 20 个工具端到端 / 本地服务安全面（CORS、Content-Type、Origin、Host、体积上限）
 * 退出码：0 全通过；1 有失败；2 环境问题（起不来实例等）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const argv = process.argv.slice(2)
const NO_BUILD = argv.includes('--no-build') || process.env.CALDESK_SKIP_BUILD === '1'
const KEEP = argv.includes('--keep')
const portArgIndex = argv.indexOf('--port')
const FIXED_PORT = portArgIndex >= 0 ? Number(argv[portArgIndex + 1]) : 0

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

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  return assert(name, a === e, `期望 ${e}\n实际 ${a}`)
}

/* ------------------------------ 环境准备 ------------------------------ */

function electronBinary() {
  const require_ = createRequire(import.meta.url)
  try {
    const p = require_('electron')
    if (typeof p === 'string' && existsSync(p)) return p
  } catch {
    /* 走下面的兜底 */
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
  // 传单条命令字符串而不是 args 数组：Windows 下 .cmd 必须走 shell，数组形式会触发 DEP0190
  const res = spawnSync('npm run build', {
    cwd: ROOT,
    shell: true,
    encoding: 'utf-8'
  })
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitHealth(port, timeoutMs = 40000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      // 校验 body 里的 app 字段，避免端口上恰好是别的服务就误判成功
      const r = await httpReq(port, { method: 'GET', path: '/health', headers: {}, timeout: 1500 })
      if (r.status === 200 && JSON.parse(r.text).app === 'caldesk') return true
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  return false
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return
  child.__expectedExit = true // 我们自己杀的，别把它当成启动失败报出来
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

/** 起一个隔离实例。env 额外变量用于「带令牌」的第二个实例 */
async function startInstance({ userDataDir, port, env = {}, logFile }) {
  const exe = electronBinary()
  if (!exe) throw new Error('找不到 electron 可执行文件（node_modules/electron 是否安装？）')
  mkdirSync(userDataDir, { recursive: true })
  const childEnv = { ...process.env, ...env, CALDESK_MCP_PORT: String(port) }
  delete childEnv.ELECTRON_RUN_AS_NODE // 本会话默认开着，会让 electron 退化成纯 Node
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE
  const log = logFile ? createWriteStreamSafe(logFile) : null
  const child = spawn(exe, ['.', `--user-data=${userDataDir}`], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const chunks = []
  const collect = (d) => {
    if (chunks.length < 400) chunks.push(d.toString())
    log?.stream.write(d)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('exit', (code) => {
    if (child.__expectedExit) return
    if (code !== 0 && code !== null) {
      process.stderr.write(`[electron 退出 code=${code}]\n${chunks.slice(-40).join('')}\n`)
    }
  })
  const ok = await waitHealth(port)
  if (!ok) {
    killTree(child)
    throw new Error(`隔离实例在 ${port} 端口没有起来。进程输出：\n${chunks.slice(-40).join('')}`)
  }
  return { child, port, userDataDir }
}

function createWriteStreamSafe(file) {
  const fd = openSync(file, 'a')
  return {
    stream: {
      write(d) {
        try {
          writeSync(fd, d)
        } catch {
          /* 忽略日志写失败 */
        }
      }
    }
  }
}

/* ------------------------------ HTTP 客户端 ------------------------------ */

/** 用 node:http 而不是 fetch：这样才能伪造 Host 头、控制 Content-Length */
function httpReq(port, { method = 'POST', path = '/mcp', headers = {}, body = null, chunked = false, timeout = 15000 } = {}) {
  return new Promise((resolveFn, rejectFn) => {
    const opts = { host: '127.0.0.1', port, method, path, headers: { ...headers } }
    if (body != null && !chunked && opts.headers['content-length'] === undefined) {
      opts.headers['content-length'] = Buffer.byteLength(body)
    }
    const req = http.request(opts, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (d) => {
        data += d
      })
      res.on('end', () =>
        resolveFn({ status: res.statusCode, headers: res.headers, text: data })
      )
    })
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')))
    req.on('error', rejectFn)
    if (body != null) {
      if (chunked) {
        const mid = Math.floor(body.length / 2)
        req.write(body.slice(0, mid))
        req.write(body.slice(mid))
      } else {
        req.write(body)
      }
    }
    req.end()
  })
}

function makeClient(port) {
  let seq = 0
  const client = {
    port,
    async rpc(method, params, opts = {}) {
      const payload = { jsonrpc: '2.0', id: opts.id === undefined ? ++seq : opts.id, method }
      if (params !== undefined) payload.params = params
      const r = await httpReq(port, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      let json = null
      try {
        json = JSON.parse(r.text)
      } catch {
        /* 保留原文 */
      }
      return { ...r, json }
    },
    async call(name, args = {}) {
      const r = await client.rpc('tools/call', { name, arguments: args })
      const result = r.json?.result
      let data = null
      if (result && !result.isError) {
        try {
          data = JSON.parse(result.content[0].text)
        } catch {
          data = result.content?.[0]?.text ?? null
        }
      }
      return {
        http: r.status,
        isError: Boolean(result?.isError),
        text: result?.content?.map((c) => c.text).join('\n'),
        data,
        rpcError: r.json?.error,
        raw: r
      }
    },
    raw: (opts) => httpReq(port, opts)
  }
  return client
}

const ok = (r) => r.isError === false && !r.rpcError
const bad = (r) => r.isError === true || Boolean(r.rpcError)

/* ------------------------------ 主流程 ------------------------------ */

let inst = null
let tokenInst = null
let userDataDir = ''
let tokenUserDataDir = ''
const cli = { port: 0 }

async function main() {
  buildIfNeeded()
  const port = FIXED_PORT || (await freePort())
  const tokenPort = FIXED_PORT ? FIXED_PORT + 1 : await freePort()
  const id = randomUUID().slice(0, 8)
  userDataDir = join(tmpdir(), `caldesk-verify-mcp-${id}`)
  tokenUserDataDir = join(tmpdir(), `caldesk-verify-mcp-token-${id}`)

  console.log(`· 隔离实例端口 ${port}，数据目录 ${userDataDir}`)
  inst = await startInstance({
    userDataDir,
    port,
    logFile: join(userDataDir, 'electron.log')
  })
  cli.port = port
  const api = makeClient(port)

  await runSuite('协议', () => protocolSuite(api))
  await runSuite('安全', () => securitySuite(api, port))
  await runSuite('工具', () => toolSuite(api))
  await runSuite('稳健性', () => robustnessSuite(api))
  await runSuite('stdio 桥', bridgeSuite)
  await runSuite('可选令牌', () => tokenSuite(tokenPort, tokenUserDataDir))
  flushGroup()

  console.log(`\n${'─'.repeat(56)}`)
  if (failures.length === 0) {
    console.log(`全部通过：${pass} 项断言`)
  } else {
    console.log(`失败 ${failures.length} 项 / 通过 ${pass} 项`)
    for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name}`)
  }
}

/* ------------------------------ 1. 协议层 ------------------------------ */

async function protocolSuite(api) {
  group('协议：initialize / notifications')

  const init = await api.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-mcp', version: '1.0.0' }
  })
  eq('initialize 回显请求的协议版本', init.json?.result?.protocolVersion, '2025-06-18')
  eq('initialize 声明 tools 能力', Object.keys(init.json?.result?.capabilities ?? {}), ['tools'])
  eq('initialize serverInfo.name', init.json?.result?.serverInfo?.name, 'caldesk')
  assert('initialize 回显 id', init.json?.id === 1, `id=${init.json?.id}`)

  const initOld = await api.rpc('initialize', { protocolVersion: '1999-01-01' })
  assert(
    '未知协议版本回落到支持的最新版',
    typeof initOld.json?.result?.protocolVersion === 'string' &&
      initOld.json.result.protocolVersion !== '1999-01-01',
    instant(initOld.json)
  )

  const notif = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  assert('notifications/initialized 回 202 且无 body', notif.status === 202 && notif.text === '', instant(notif))

  const notifBadJson = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', method: 'notifications/initialized' })
  })
  assert('非法通知也不回包（JSON-RPC 2.0 §4.1）', notifBadJson.status === 202 && notifBadJson.text === '', instant(notifBadJson))

  // 通知形式的 tools/call：执行副作用但不回包
  const notifCall = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'items_append_line', arguments: { date: '2031-01-01', text: '通知写入' } }
    })
  })
  assert('通知形式 tools/call 不回包', notifCall.status === 202 && notifCall.text === '', instant(notifCall))
  const afterNotif = await api.call('items_get', { date: '2031-01-01' })
  eq('通知形式 tools/call 的副作用确实执行了', afterNotif.data?.lines, ['通知写入'])

  group('协议：tools/list')

  const list = await api.rpc('tools/list')
  const tools = list.json?.result?.tools ?? []
  const EXPECTED = [
    'context', 'calendar_list', 'items_get', 'items_query', 'items_append_line', 'items_set',
    'item_line_update', 'item_line_delete', 'item_line_set_done', 'item_line_move',
    'events_query', 'event_create', 'event_update', 'event_delete', 'search',
    'notes_list', 'notes_get', 'notes_create', 'notes_update', 'notes_delete'
  ]
  eq('工具数量为 20', tools.length, 20)
  eq('工具名称与约定一致', tools.map((t) => t.name).sort(), [...EXPECTED].sort())
  assert(
    '每个工具都有非空 description 和 object 型 inputSchema',
    tools.every((t) => t.description && t.inputSchema?.type === 'object' && typeof t.inputSchema.properties === 'object'),
    instant(tools.filter((t) => !t.description || t.inputSchema?.type !== 'object').map((t) => t.name))
  )
  assert(
    'required 里的字段都在 properties 中',
    tools.every((t) =>
      (t.inputSchema.required ?? []).every((k) => Object.prototype.hasOwnProperty.call(t.inputSchema.properties, k))
    ),
    instant(tools.map((t) => t.name))
  )
  const lineMove = tools.find((t) => t.name === 'item_line_move')
  eq('item_line_move 的 index 声明了 minimum 0', lineMove?.inputSchema.properties.index?.minimum, 0)

  group('协议：JSON-RPC 错误码')

  const unknownMethod = await api.rpc('nope/nope')
  eq('未知 method → -32601', unknownMethod.json?.error?.code, -32601)

  const parseErr = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: '{not json'
  })
  assert('解析错误 → HTTP 400 + -32700', parseErr.status === 400 && JSON.parse(parseErr.text).error.code === -32700, instant(parseErr))

  const badVersion = await api.rpc('tools/list', undefined, { note: 'ignored' })
  assert('正常请求返回 200', badVersion.status === 200, instant(badVersion))

  const invalid = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 5, method: 'tools/list' })
  })
  const invalidJson = JSON.parse(invalid.text)
  assert('缺 jsonrpc → -32600', invalidJson.error?.code === -32600, instant(invalidJson))

  const badId = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })
  })
  assert('id 类型非法 → -32600', JSON.parse(badId.text).error?.code === -32600, instant(badId))

  const idEcho = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'ping' })
  })
  eq('字符串 id 原样回显', JSON.parse(idEcho.text).id, 'abc')

  const idNull = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' })
  })
  eq('id=null 原样回显', JSON.parse(idNull.text).id, null)

  const noName = await api.rpc('tools/call', {})
  eq('tools/call 缺 name → -32602', noName.json?.error?.code, -32602)

  const unknownTool = await api.rpc('tools/call', { name: 'nope', arguments: {} })
  eq('未知工具名 → -32602', unknownTool.json?.error?.code, -32602)

  const paramsArray = await api.rpc('tools/call', [])
  eq('params 为数组 → -32602', paramsArray.json?.error?.code, -32602)

  const argsString = await api.rpc('tools/call', { name: 'context', arguments: 'x' })
  eq('arguments 非对象 → -32602', argsString.json?.error?.code, -32602)

  const toolError = await api.call('items_get', {})
  assert(
    '工具内部报错走 result.isError（不是 JSON-RPC error）',
    toolError.isError === true && !toolError.rpcError && toolError.http === 200,
    instant(toolError)
  )

  group('协议：批次 / 通知过滤')

  const batch = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 101, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 102, method: 'tools/list' }
    ])
  })
  const batchJson = JSON.parse(batch.text)
  assert('批次返回数组且跳过通知', Array.isArray(batchJson) && batchJson.length === 2, instant(batchJson))

  const emptyBatch = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: '[]'
  })
  eq('空批次 → -32600', JSON.parse(emptyBatch.text).error?.code, -32600)

  group('协议：UTF-8 与并发')

  const zh = await api.call('items_append_line', { date: '2031-01-02', text: '中文🚀测试' })
  assert('中文/emoji 正常写入', ok(zh) && zh.data.lines?.[0] === '中文🚀测试', instant(zh))
  const zhRaw = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'items_get', arguments: { date: '2031-01-02' } } })
  })
  const declared = Number(zhRaw.headers['content-length'])
  assert(
    'Content-Length 按字节数（不是字符数）',
    declared === Buffer.byteLength(zhRaw.text, 'utf8'),
    `头 ${declared} / 实际字节 ${Buffer.byteLength(zhRaw.text, 'utf8')} / 字符 ${zhRaw.text.length}`
  )

  const N = 20
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      api.call('items_append_line', { date: '2031-01-03', text: `并发${i}` })
    )
  )
  assert(`并发 ${N} 次追加都成功`, results.every((r) => ok(r)), instant(results.filter((r) => !ok(r)).map((r) => r.text)))
  const merged = await api.call('items_get', { date: '2031-01-03' })
  eq(`并发 ${N} 次追加无丢失`, merged.data?.lines?.length, N)

  // Keep-Alive：同一个 agent 连发两条
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  const ka = await new Promise((resolveFn) => {
    const out = []
    let count = 0
    const send = () => {
      const req = http.request(
        { host: '127.0.0.1', port: api.port, method: 'POST', path: '/mcp', agent, headers: { 'content-type': 'application/json' } },
        (res) => {
          let t = ''
          res.on('data', (d) => (t += d))
          res.on('end', () => {
            out.push({ status: res.statusCode, keepAlive: res.headers.connection, text: t })
            count += 1
            if (count < 2) send()
            else resolveFn(out)
          })
        }
      )
      req.end(JSON.stringify({ jsonrpc: '2.0', id: count + 1, method: 'ping' }))
    }
    send()
  })
  agent.destroy()
  assert(
    'Keep-Alive 连续请求都成功',
    ka.length === 2 && ka.every((r) => r.status === 200 && JSON.parse(r.text).id !== undefined),
    instant(ka.map((r) => r.status))
  )
}

/* ------------------------------ 2. 安全面 ------------------------------ */

async function securitySuite(api, port) {
  group('安全：Content-Type 强制')

  const json = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  for (const ct of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', null]) {
    const headers = ct ? { 'content-type': ct } : {}
    const r = await api.raw({ headers, body: json })
    assert(`POST /mcp 的 Content-Type=${ct ?? '(缺失)'} → 415`, r.status === 415, `实际 ${r.status} ${r.text.slice(0, 120)}`)
  }
  const jsonOk = await api.raw({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: json })
  assert('Content-Type=application/json;charset=utf-8 放行', jsonOk.status === 200, instant(jsonOk))

  group('安全：Origin 校验')

  const evilPost = await api.raw({
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: json
  })
  assert('Origin=evil.example 的 POST → 403', evilPost.status === 403, instant(evilPost))
  assert(
    '被拒的跨源响应不带 Access-Control-Allow-Origin',
    evilPost.headers['access-control-allow-origin'] === undefined,
    instant(evilPost.headers)
  )

  const nullOrigin = await api.raw({
    headers: { 'content-type': 'application/json', origin: 'null' },
    body: json
  })
  assert('Origin=null（file:// /沙箱 iframe）→ 403', nullOrigin.status === 403, instant(nullOrigin))

  const localOrigin = await api.raw({
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: json
  })
  assert('Origin=本机回环 → 200', localOrigin.status === 200, instant(localOrigin))
  eq('本机来源会回 Access-Control-Allow-Origin', localOrigin.headers['access-control-allow-origin'], `http://127.0.0.1:${port}`)

  const evilOptions = await api.raw({
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' }
  })
  assert('越权预检 → 403（浏览器因此不会发出真实请求）', evilOptions.status === 403, instant(evilOptions))

  const goodOptions = await api.raw({
    method: 'OPTIONS',
    headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' }
  })
  assert('本机来源预检 → 204', goodOptions.status === 204, instant(goodOptions))
  assert(
    '预检回 Allow-Methods / Allow-Headers',
    (goodOptions.headers['access-control-allow-methods'] ?? '').includes('POST') &&
      (goodOptions.headers['access-control-allow-headers'] ?? '').includes('content-type'),
    instant(goodOptions.headers)
  )

  group('安全：Host / 方法 / 体积')

  const badHost = await api.raw({
    headers: { 'content-type': 'application/json', host: 'evil.example:19283' },
    body: json
  })
  assert('Host=DNS rebinding 域名 → 403', badHost.status === 403, instant(badHost))

  const getMcp = await api.raw({ method: 'GET', headers: {} })
  assert('GET /mcp → 405（不提供 SSE）', getMcp.status === 405, instant(getMcp))
  eq('405 带 Allow 头', getMcp.headers.allow, 'POST, OPTIONS')

  const putMcp = await api.raw({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: json })
  assert('PUT /mcp → 405', putMcp.status === 405, instant(putMcp))

  const health = await api.raw({ method: 'GET', path: '/health', headers: {} })
  eq('/health 可用', health.status, 200)
  const notFound = await api.raw({ method: 'GET', path: '/nope', headers: {} })
  eq('未知路径 → 404', notFound.status, 404)

  const big = JSON.stringify({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'items_set', arguments: { date: '2031-02-01', text: 'x'.repeat(1_200_000) } }
  })
  const bigRes = await api.raw({ headers: { 'content-type': 'application/json' }, body: big })
  assert('超过 1MB 的请求体 → 413（不是连接被掐断）', bigRes.status === 413, `实际 ${bigRes.status}`)

  const chunkedBig = await api.raw({
    headers: { 'content-type': 'application/json' },
    body: big,
    chunked: true
  })
  assert('无 Content-Length 的超大请求 → 413', chunkedBig.status === 413, `实际 ${chunkedBig.status}`)

  group('安全：只监听回环')

  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)[0]
  if (!lan) {
    console.log('  · 跳过：本机没有非回环 IPv4 地址')
  } else {
    const reachable = await new Promise((resolveFn) => {
      const sock = http.request(
        { host: lan, port, method: 'GET', path: '/health', timeout: 1500 },
        () => resolveFn(true)
      )
      sock.on('timeout', () => {
        sock.destroy()
        resolveFn(false)
      })
      sock.on('error', () => resolveFn(false))
      sock.end()
    })
    assert(`从局域网地址 ${lan}:${port} 连不上（只绑 127.0.0.1）`, reachable === false)
  }

  group('安全：SQL 注入面无残留')

  const injectSearch = await api.call('search', { query: "' OR 1=1 --" })
  assert('search 的 SQL 片段只当普通关键词', ok(injectSearch) && Array.isArray(injectSearch.data), instant(injectSearch))
  const injectDate = await api.call('items_get', { date: "2026-01-01'; DROP TABLE day_cells;--" })
  assert('日期参数里的注入被格式校验挡住', bad(injectDate), instant(injectDate))
  const injectCal = await api.call('items_get', { date: '2031-03-01', calendar_id: "' OR '1'='1" })
  assert('calendar_id 注入得到「视图不存在」', bad(injectCal), instant(injectCal))
  const alive = await api.rpc('tools/call', { name: 'calendar_list', arguments: {} })
  assert('注入尝试后日历表仍可读（服务未被打坏）', alive.json?.result && !alive.json.result.isError, instant(alive.json))
}

function instant(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > 600 ? s.slice(0, 600) + '…' : s
}

/* ------------------------------ 3. 20 个工具 ------------------------------ */

async function toolSuite(api) {
  const cals = await api.call('calendar_list')
  const calA = cals.data?.[0]?.id
  const calB = cals.data?.[1]?.id ?? calA

  group('工具：context / calendar_list')
  const ctx = await api.call('context')
  assert('context 返回 today(YYYY-MM-DD)', /^\d{4}-\d{2}-\d{2}$/.test(ctx.data?.today ?? ''), instant(ctx.data))
  assert('context 返回 default_calendar_id', typeof ctx.data?.default_calendar_id === 'string', instant(ctx.data))
  assert('context calendar_count ≥ 1', (ctx.data?.calendar_count ?? 0) >= 1, instant(ctx.data))
  assert('context 返回 timezone', typeof ctx.data?.timezone === 'string', instant(ctx.data))
  assert('calendar_list 返回 id/name/color', Array.isArray(cals.data) && cals.data.every((c) => c.id && c.name && c.color), instant(cals.data))

  group('工具：items_get / items_query')
  const emptyCell = await api.call('items_get', { date: '2032-01-01' })
  eq('items_get 空日 → text 为空串', emptyCell.data?.text, '')
  eq('items_get 空日 → lines 为空数组', emptyCell.data?.lines, [])
  assert('items_get 必填 date 缺失时报错', bad(await api.call('items_get', {})), '缺 date 应报错')
  assert('items_get 非法日期（2026-02-30）报错', bad(await api.call('items_get', { date: '2026-02-30' })))
  assert('items_get 不存在视图报错', bad(await api.call('items_get', { date: '2032-01-01', calendar_id: 'nope' })))

  await api.call('items_set', { date: '2032-01-02', text: 'A\nB' })
  const q = await api.call('items_query', { from: '2032-01-01', to: '2032-01-03' })
  assert('items_query 只返回有内容的日格', Array.isArray(q.data) && q.data.length === 1 && q.data[0].date === '2032-01-02', instant(q.data))
  assert('items_query from > to 报错', bad(await api.call('items_query', { from: '2032-01-03', to: '2032-01-01' })))
  assert('items_query 缺 to 报错', bad(await api.call('items_query', { from: '2032-01-01' })))

  group('工具：items_append_line / items_set')
  const app = await api.call('items_append_line', { date: '2032-01-10', text: '买牛奶' })
  assert('items_append_line 成功并返回整格', ok(app) && app.data.lines.length === 1, instant(app))
  assert('items_append_line 拒绝多行文本', bad(await api.call('items_append_line', { date: '2032-01-10', text: 'a\nb' })))
  assert('items_append_line 拒绝空文本', bad(await api.call('items_append_line', { date: '2032-01-10', text: '   ' })))
  assert('items_append_line 拒绝数字型 text', bad(await api.call('items_append_line', { date: '2032-01-10', text: 123 })))
  const emoji = await api.call('items_append_line', { date: '2032-01-10', text: '🎉 打卡 ~~已办~~' })
  assert('items_append_line 正确处理 emoji/~~ 标记', ok(emoji) && emoji.data.lines.at(-1) === '🎉 打卡 ~~已办~~', instant(emoji.data))

  const setEmpty = await api.call('items_set', { date: '2032-01-11', text: 'x' })
  assert('items_set 写入整格', ok(setEmpty))
  const cleared = await api.call('items_set', { date: '2032-01-11', text: '' })
  eq('items_set 空串 = 清空整格', cleared.data?.text, '')
  const crlf = await api.call('items_set', { date: '2032-01-12', text: 'a\r\nb' })
  eq('items_set 把 CRLF 归一成 LF（行号才不错位）', crlf.data?.lines, ['a', 'b'])
  const longOk = await api.call('items_set', { date: '2032-01-13', text: 'x'.repeat(20000) })
  assert('items_set 20000 字符（上限内）成功', ok(longOk))
  assert('items_set 20001 字符报错', bad(await api.call('items_set', { date: '2032-01-13', text: 'x'.repeat(20001) })))

  group('工具：item_line_update / delete / set_done')
  await api.call('items_set', { date: '2032-02-01', text: 'L0\nL1\nL2' })
  const upd = await api.call('item_line_update', { date: '2032-02-01', index: 1, text: 'L1b' })
  eq('item_line_update 按行号改', upd.data?.lines, ['L0', 'L1b', 'L2'])
  assert('item_line_update index 传字符串报错', bad(await api.call('item_line_update', { date: '2032-02-01', index: '1', text: 'x' })))
  assert('item_line_update index 传负数报错', bad(await api.call('item_line_update', { date: '2032-02-01', index: -1, text: 'x' })))
  assert('item_line_update index 越界报错 (99)', bad(await api.call('item_line_update', { date: '2032-02-01', index: 99, text: 'x' })))
  assert('item_line_update 文本含换行报错', bad(await api.call('item_line_update', { date: '2032-02-01', index: 0, text: 'a\nb' })))

  const del = await api.call('item_line_delete', { date: '2032-02-01', index: 0 })
  eq('item_line_delete 删除指定行', del.data?.lines, ['L1b', 'L2'])
  assert('item_line_delete 越界报错', bad(await api.call('item_line_delete', { date: '2032-02-01', index: 9 })))

  const done = await api.call('item_line_set_done', { date: '2032-02-01', index: 0, done: true })
  eq('item_line_set_done true → ~~文本~~', done.data?.lines[0], '~~L1b~~')
  const undone = await api.call('item_line_set_done', { date: '2032-02-01', index: 0, done: false })
  eq('item_line_set_done false → 去掉删除线', undone.data?.lines[0], 'L1b')
  assert('item_line_set_done 传字符串 "false" 被拒（不会误判成 true）', bad(await api.call('item_line_set_done', { date: '2032-02-01', index: 0, done: 'false' })))
  assert('item_line_set_done 传 1 被拒', bad(await api.call('item_line_set_done', { date: '2032-02-01', index: 0, done: 1 })))

  group('工具：item_line_move')
  await api.call('items_set', { date: '2032-03-01', text: 'm0\nm1' })
  await api.call('items_set', { date: '2032-03-02', text: 'dst' })
  const moved = await api.call('item_line_move', { from_date: '2032-03-01', index: 0, to_date: '2032-03-02' })
  assert('item_line_move 成功并返回 moved/from/to', ok(moved) && moved.data?.moved === 'm0', instant(moved))
  const dst = await api.call('items_get', { date: '2032-03-02' })
  eq('目标格追加在末尾', dst.data?.lines, ['dst', 'm0'])
  const src = await api.call('items_get', { date: '2032-03-01' })
  eq('源格被移除该行', src.data?.lines, ['m1'])

  await api.call('items_set', { date: '2032-03-05', text: 'same' })
  const sameDay = await api.call('item_line_move', { from_date: '2032-03-05', index: 0, to_date: '2032-03-05' })
  assert('item_line_move 同天移动被拒（否则会丢行）', bad(sameDay), instant(sameDay))
  const sameDayAfter = await api.call('items_get', { date: '2032-03-05' })
  eq('同天移动被拒后数据完好', sameDayAfter.data?.lines, ['same'])
  assert('item_line_move 目标日期非法报错', bad(await api.call('item_line_move', { from_date: '2032-03-01', index: 0, to_date: '2032-13-01' })))

  group('工具：events_query')
  const evQ = await api.call('events_query', { from: '2032-04-01', to: '2032-04-30' })
  assert('events_query 返回数组', ok(evQ) && Array.isArray(evQ.data), instant(evQ))
  assert('events_query kind 非法时报错（不是静默空数组）', bad(await api.call('events_query', { from: '2032-04-01', to: '2032-04-30', kind: 'bogus' })))
  assert('events_query from > to 报错', bad(await api.call('events_query', { from: '2032-04-30', to: '2032-04-01' })))

  group('工具：event_create / event_update / event_delete')
  const oneOff = await api.call('event_create', { title: '单次任务', kind: 'task', start: '2032-04-10' })
  assert('event_create 单次事件成功', ok(oneOff) && typeof oneOff.data?.id === 'string', instant(oneOff))
  assert('event_create 回显 rrule/target_date 便于校验', 'rrule' in (oneOff.data ?? {}) && 'target_date' in (oneOff.data ?? {}), instant(oneOff.data))
  const weekly = await api.call('event_create', { title: '每周会', kind: 'reminder', start: '2032-04-05', rrule: 'FREQ=WEEKLY;BYDAY=MO' })
  eq('event_create 保存 rrule', weekly.data?.rrule, 'FREQ=WEEKLY;BYDAY=MO')
  assert('event_create countdown 缺 target_date 报错', bad(await api.call('event_create', { title: 'x', kind: 'countdown', start: '2032-04-01' })))
  assert('event_create countdown 带 rrule 报错', bad(await api.call('event_create', { title: 'x', kind: 'countdown', start: '2032-04-01', target_date: '2032-05-01', rrule: 'FREQ=DAILY' })))
  const cd = await api.call('event_create', { title: '生日', kind: 'countdown', start: '2032-04-01', target_date: '2032-04-20' })
  eq('event_create countdown 正常', cd.data?.target_date, '2032-04-20')
  assert('event_create kind 非法报错', bad(await api.call('event_create', { title: 'x', kind: 'weird', start: '2032-04-01' })))
  assert('event_create start 非法报错', bad(await api.call('event_create', { title: 'x', kind: 'task', start: 'nope' })))
  assert('event_create 空标题报错', bad(await api.call('event_create', { title: '  ', kind: 'task', start: '2032-04-01' })))
  assert('event_create remind_minutes 越界报错', bad(await api.call('event_create', { title: 'x', kind: 'reminder', start: '2032-04-01', remind_minutes: 99999 })))

  const evQ2 = await api.call('events_query', { from: '2032-04-01', to: '2032-04-30', kind: 'reminder' })
  assert('kind=reminder 过滤生效', ok(evQ2) && evQ2.data.every((e) => e.kind === 'reminder'), instant(evQ2.data))

  const updTitle = await api.call('event_update', { id: oneOff.data.id, title: '改名后' })
  eq('event_update 改标题', updTitle.data?.title, '改名后')
  assert('event_update 无字段报错', bad(await api.call('event_update', { id: oneOff.data.id })))
  assert('event_update 不存在 id 报错', bad(await api.call('event_update', { id: 'nope', title: 'x' })))
  const clearTarget = await api.call('event_update', { id: cd.data.id, kind: 'task', target_date: null })
  eq('event_update 用 null 清空 target_date 并切类型', clearTarget.data?.target_date, null)

  assert('event_delete 成功', ok(await api.call('event_delete', { id: oneOff.data.id })))
  assert('event_delete 重复删除报错', bad(await api.call('event_delete', { id: oneOff.data.id })))
  assert('event_delete 缺 id 报错', bad(await api.call('event_delete', {})))

  group('工具：search')
  await api.call('items_set', { date: '2032-05-01', text: '独特关键词ABC' })
  await api.call('event_create', { title: '独特关键词ABC 事件', kind: 'task', start: '2032-05-02' })
  await api.call('notes_create', { content: '独特关键词ABC 便签' })
  const hits = await api.call('search', { query: '独特关键词ABC' })
  assert('search 命中 task/event/note 三类', ok(hits) && ['task', 'event', 'note'].every((t) => hits.data.some((h) => h.type === t)), instant(hits.data))
  assert('search 结果字段与类型定义一致', hits.data.every((h) => h.calendarId && h.calendarName && h.date && h.title), instant(hits.data[0]))
  assert('search limit=0 报错', bad(await api.call('search', { query: '独特关键词ABC', limit: 0 })))
  assert('search limit=-5 报错', bad(await api.call('search', { query: '独特关键词ABC', limit: -5 })))
  assert('search limit=1e9 报错（超出 200）', bad(await api.call('search', { query: '独特关键词ABC', limit: 1e9 })))
  assert('search limit 非整数报错', bad(await api.call('search', { query: '独特关键词ABC', limit: 'abc' })))
  assert('search 空关键词报错', bad(await api.call('search', { query: '   ' })))
  assert('search 缺 query 报错', bad(await api.call('search', {})))
  const scoped = await api.call('search', { query: '独特关键词ABC', calendar_id: calA })
  assert('search 支持按 calendar_id 过滤', ok(scoped) && scoped.data.every((h) => h.calendarId === calA), instant(scoped.data))
  const wildcard = await api.call('search', { query: '%' })
  assert('search 里的 % 被当字面量', ok(wildcard), instant(wildcard))

  group('工具：notes_*')
  const note = await api.call('notes_create', { content: '正文内容', title: '标题A' })
  assert('notes_create 成功返回 id/title', ok(note) && typeof note.data?.id === 'string', instant(note))
  assert('notes_create 内容与标题都空时报错', bad(await api.call('notes_create', { content: '' })))
  const noteGet = await api.call('notes_get', { id: note.data.id })
  eq('notes_get 返回完整内容', noteGet.data?.content, '正文内容')
  assert('notes_get 缺 id 报错', bad(await api.call('notes_get', {})))
  assert('notes_get 不存在 id 报错', bad(await api.call('notes_get', { id: 'nope' })))

  const noteList = await api.call('notes_list')
  assert('notes_list 默认返回数组', ok(noteList) && Array.isArray(noteList.data), instant(noteList))
  assert('notes_list 条目含 preview/pinned/updatedAt', noteList.data.every((n) => 'preview' in n && 'pinned' in n && 'updatedAt' in n), instant(noteList.data[0]))
  const limited = await api.call('notes_list', { limit: 1 })
  assert('notes_list limit=1 生效', ok(limited) && limited.data.length <= 1, instant(limited.data))
  assert('notes_list limit=0 报错', bad(await api.call('notes_list', { limit: 0 })))
  assert('notes_list limit 非整数报错', bad(await api.call('notes_list', { limit: 'x' })))
  const byCal = await api.call('notes_list', { calendar_id: calB })
  assert('notes_list 按 calendar_id 过滤', ok(byCal) && byCal.data.every((n) => n.calendar_id === calB), instant(byCal.data))

  const noteUpd = await api.call('notes_update', { id: note.data.id, title: '标题B', pinned: true })
  eq('notes_update 改标题', noteUpd.data?.title, '标题B')
  eq('notes_update 改置顶', noteUpd.data?.pinned, true)
  assert('notes_update 无字段报错', bad(await api.call('notes_update', { id: note.data.id })))
  assert('notes_update 不存在 id 报错', bad(await api.call('notes_update', { id: 'nope', title: 'x' })))
  assert('notes_delete 成功', ok(await api.call('notes_delete', { id: note.data.id })))
  assert('notes_delete 重复删除报错', bad(await api.call('notes_delete', { id: note.data.id })))
}

/* ------------------------------ 4. 稳健性 ------------------------------ */

async function robustnessSuite(api) {
  group('稳健性：长连接 / 连续调用')

  // 连打 50 次（含只读与写），确认没有连接泄漏、没有状态错乱
  const rounds = 50
  const seq = []
  for (let i = 0; i < rounds; i += 1) {
    seq.push(i % 2 === 0 ? api.call('context') : api.call('calendar_list'))
  }
  const out = await Promise.all(seq)
  assert(`${rounds} 次混合调用全部成功`, out.every((r) => ok(r)), instant(out.filter((r) => !ok(r)).map((r) => r.text)))

  // 服务端必须在收到非法 JSON 后仍然健康
  await api.raw({ headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":' })
  const afterBad = await api.rpc('ping')
  assert('收到坏 JSON 后服务仍正常', afterBad.status === 200 && afterBad.json?.result !== undefined, instant(afterBad))
}

/* ------------------------------ 5. stdio 桥 ------------------------------ */

const BRIDGE = join(ROOT, 'bin', 'cal-mcp.mjs')

function runBridge(lines, { env = {}, timeout = 25000 } = {}) {
  const childEnv = { ...process.env }
  delete childEnv.CALDESK_URL
  delete childEnv.CALDESK_TOKEN
  delete childEnv.CALDESK_RUNTIME
  delete childEnv.ELECTRON_RUN_AS_NODE
  Object.assign(childEnv, env)
  const res = spawnSync(process.execPath, [BRIDGE], {
    env: childEnv,
    input: lines.map((l) => `${l}\n`).join(''),
    encoding: 'utf-8',
    timeout
  })
  const outLines = (res.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  return {
    status: res.status,
    signal: res.signal,
    stderr: res.stderr ?? '',
    outLines,
    json: outLines.map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
  }
}

async function bridgeSuite() {
  group('stdio 桥：握手 / stdout 纯净 / 上游故障')

  const runtimeFile = join(userDataDir, 'runtime.json')
  const req = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })

  const run = runBridge(
    [
      req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-verify', version: '1' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      req(2, 'tools/list'),
      req(3, 'tools/call', { name: 'context', arguments: {} })
    ],
    { env: { CALDESK_RUNTIME: runtimeFile } }
  )
  assert('桥进程正常退出（stdin 关闭后退出）', run.status === 0 && !run.signal, `status=${run.status} signal=${run.signal}\n${run.stderr}`)
  assert(
    'stdout 每一行都是合法 JSON-RPC（无 console.log 污染）',
    run.outLines.length > 0 && run.json.every((j) => j && j.jsonrpc === '2.0'),
    instant(run.outLines.join('\n').slice(0, 400))
  )
  eq('通知不产生应答：4 条输入 → 3 条输出', run.outLines.length, 3)
  eq('桥把 initialize 的应答原样传回', run.json[0]?.result?.serverInfo?.name, 'caldesk')
  eq('桥把 tools/list 的 20 个工具传回', run.json[1]?.result?.tools?.length, 20)
  assert('桥把 tools/call 结果传回', run.json[2]?.result?.content?.[0]?.text?.includes('today'), instant(run.json[2]))
  eq('应答 id 与请求 id 对应', run.json.map((j) => j?.id), [1, 2, 3])

  // 大响应：20000 字符的日格，桥要整行传回且仍是单行合法 JSON
  await makeClient(inst.port).call('items_set', { date: '2034-01-01', text: 'x'.repeat(20000) })
  const bigRun = runBridge([req(9, 'tools/call', { name: 'items_get', arguments: { date: '2034-01-01' } })], {
    env: { CALDESK_RUNTIME: runtimeFile }
  })
  assert('大响应仍是单行合法 JSON', bigRun.outLines.length === 1 && bigRun.json[0]?.result && bigRun.outLines[0].length > 20000, `lines=${bigRun.outLines.length} len=${bigRun.outLines[0]?.length}`)

  // 上游端口不对：必须回错误而不是静默挂死
  const downRun = runBridge([req(5, 'initialize', { protocolVersion: '2025-06-18' })], {
    env: { CALDESK_URL: 'http://127.0.0.1:1' }
  })
  assert('上游不可达时进程仍会退出（不挂死）', downRun.status === 0 && !downRun.signal, `status=${downRun.status} signal=${downRun.signal}`)
  assert(
    '上游不可达时回带原 id 的 JSON-RPC 错误',
    downRun.json[0]?.id === 5 && typeof downRun.json[0]?.error?.message === 'string',
    instant(downRun.outLines.join('\n'))
  )
  assert('上游不可达时 stderr 有诊断信息', /无法连接 caldesk/.test(downRun.stderr), downRun.stderr)

  // 找不到 runtime.json：同样要报错
  const noRuntime = runBridge([req(6, 'initialize', { protocolVersion: '2025-06-18' })], {
    env: { CALDESK_RUNTIME: join(tmpdir(), 'caldesk-no-such-runtime.json') }
  })
  assert(
    '找不到 runtime.json 时回错误（不是静默）',
    noRuntime.json[0]?.error?.message?.includes('找不到 caldesk 的运行信息'),
    instant(noRuntime.outLines.join('\n'))
  )
  assert('找不到 runtime.json 时 stderr 有提示', /找不到 caldesk 的运行信息/.test(noRuntime.stderr), noRuntime.stderr)

  // 坏 JSON 行：上游会回 -32700，桥要透传
  const garbage = runBridge(['{not json'], { env: { CALDESK_RUNTIME: runtimeFile } })
  assert('坏 JSON 行也能得到 -32700（不吞错）', garbage.json[0]?.error?.code === -32700, instant(garbage.outLines.join('\n')))
}

/* ------------------------------ 6. 可选令牌 ------------------------------ */

async function tokenSuite(port, userDataDir) {
  group('安全：可选共享令牌（CALDESK_MCP_TOKEN）')

  tokenInst = await startInstance({
    userDataDir,
    port,
    env: { CALDESK_MCP_TOKEN: 'verify-token-123' },
    logFile: join(userDataDir, 'electron.log')
  })
  const runtimeFile = join(userDataDir, 'runtime.json')
  const runtime = JSON.parse(readFileSync(runtimeFile, 'utf-8'))
  eq('启用令牌后 runtime.json 里写入 token', runtime.token, 'verify-token-123')

  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  const noToken = await httpReq(port, { headers: { 'content-type': 'application/json' }, body })
  assert('不带令牌 → 401', noToken.status === 401, `实际 ${noToken.status}`)
  const wrongToken = await httpReq(port, {
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body
  })
  assert('错误令牌 → 401', wrongToken.status === 401, `实际 ${wrongToken.status}`)
  const goodToken = await httpReq(port, {
    headers: { 'content-type': 'application/json', authorization: 'Bearer verify-token-123' },
    body
  })
  assert('正确令牌 → 200', goodToken.status === 200, `实际 ${goodToken.status} ${goodToken.text.slice(0, 120)}`)
  const health = await httpReq(port, { method: 'GET', path: '/health', headers: {} })
  eq('/health 不需要令牌（便于探活）', health.status, 200)

  // CLI 与 stdio 桥必须能自动读到令牌
  const cliEnv = { ...process.env, CALDESK_RUNTIME: runtimeFile }
  delete cliEnv.CALDESK_URL
  delete cliEnv.CALDESK_TOKEN
  const cliRun = spawnSync(process.execPath, [join(ROOT, 'bin', 'cal.mjs'), 'list'], {
    env: cliEnv,
    encoding: 'utf-8'
  })
  assert('cal CLI 自动带令牌（list 成功）', cliRun.status === 0, `exit ${cliRun.status}\n${cliRun.stderr}`)

  const bridge = spawnSync(
    process.execPath,
    [join(ROOT, 'bin', 'cal-mcp.mjs')],
    {
      env: cliEnv,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n',
      encoding: 'utf-8',
      timeout: 20000
    }
  )
  const bridgeLine = (bridge.stdout ?? '').trim().split('\n').filter(Boolean)[0] ?? ''
  let bridgeJson = null
  try {
    bridgeJson = JSON.parse(bridgeLine)
  } catch {
    /* 保持 null */
  }
  assert(
    'cal-mcp 桥自动带令牌（initialize 成功）',
    bridgeJson?.result?.serverInfo?.name === 'caldesk',
    `stdout=${instant(bridgeLine)}\nstderr=${instant(bridge.stderr ?? '')}`
  )
}

/* ------------------------------ 入口 ------------------------------ */

main()
  .catch((err) => {
    console.error(`\n[verify-mcp] 执行失败：${err?.message ?? err}`)
    fatal = true
    process.exitCode = 2
  })
  .finally(async () => {
    if (inst) killTree(inst.child)
    if (tokenInst) killTree(tokenInst.child)
    await sleep(600) // 给 Electron 的子进程一点退出时间，否则 Windows 上目录还被占用
    if (KEEP) {
      console.log(`· 保留临时目录：${userDataDir}`)
    } else {
      for (const dir of [userDataDir, tokenUserDataDir]) {
        if (!dir) continue
        for (let i = 0; i < 5; i += 1) {
          try {
            rmSync(dir, { recursive: true, force: true })
            break
          } catch {
            await sleep(400)
          }
        }
      }
    }
    if (fatal) console.log('\n❌ verify-mcp 未跑完（环境问题，见上面的错误）')
    else console.log(failures.length === 0 ? '\n✅ verify-mcp 全部通过' : `\n❌ verify-mcp 有 ${failures.length} 项失败`)
    process.exit(fatal ? 2 : failures.length === 0 ? 0 : 1)
  })
