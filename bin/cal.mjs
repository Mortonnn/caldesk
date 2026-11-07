#!/usr/bin/env node
/**
 * cal — caldesk 命令行客户端。
 *
 * 需要 caldesk 桌面端正在运行；通过其本地 MCP 服务（固定 127.0.0.1:19283，
 * 可用 CALDESK_MCP_PORT 改端口）通信。端口与可选令牌从 runtime.json 发现。
 *
 * 用法：
 *   cal list
 *   cal day [YYYY-MM-DD]
 *   cal add <YYYY-MM-DD> <文本...>
 *   cal done <YYYY-MM-DD> <行号>
 *   cal undone <YYYY-MM-DD> <行号>
 *   cal rm <YYYY-MM-DD> <行号>
 *   cal events [--from 日期] [--to 日期] [--kind all|task|reminder|countdown]
 *   cal new-event <标题> [--kind task|reminder|countdown] [--start 日期] [--rrule 规则] [--target 日期]
 *   cal del-event <id>
 *   cal search <关键词>
 *   cal migrate [--from 日期] [--to 日期] [--command 程序] [--arg 参数…]
 *
 * 全局：--json 输出原始 JSON（错误也是 JSON）；--url http://127.0.0.1:PORT 覆盖自动发现；
 *       --token <令牌> 覆盖 runtime.json 里的令牌；-h/--help 帮助。
 *
 * 退出码：0 成功；1 运行/接口错误；2 用法错误。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const helpWanted = argv.includes('--help') || argv.includes('-h')
const urlFlag = argv.indexOf('--url')
const explicitUrl = urlFlag >= 0 ? argv[urlFlag + 1] : null
const tokenFlag = argv.indexOf('--token')
const explicitToken = tokenFlag >= 0 ? argv[tokenFlag + 1] : null

/** 值型开关：`--flag 值` 成对剔除；`--` 之后的都当位置参数 */
const VALUE_FLAGS = new Set([
  '--url',
  '--token',
  '--from',
  '--to',
  '--kind',
  '--start',
  '--rrule',
  '--target',
  '--command',
  '--arg'
])
const dropped = new Set()
let literalMode = false
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  if (literalMode) break
  if (token === '--') {
    dropped.add(i)
    literalMode = true
    continue
  }
  if (!token.startsWith('--')) continue
  dropped.add(i)
  if (VALUE_FLAGS.has(token) && i + 1 < argv.length) dropped.add(i + 1)
}
const positional = argv.filter((_, i) => !dropped.has(i))

function runtimePath() {
  const env = process.env.CALDESK_RUNTIME
  if (env) return env
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'caldesk', 'runtime.json')
  }
  return join(homedir(), '.config', 'caldesk', 'runtime.json')
}

function readRuntime() {
  try {
    return JSON.parse(readFileSync(runtimePath(), 'utf-8'))
  } catch {
    return null
  }
}

/** 令牌优先级：--token > CALDESK_TOKEN > runtime.json（旧版本没有这个字段） */
function token() {
  if (explicitToken) return explicitToken
  if (process.env.CALDESK_TOKEN) return process.env.CALDESK_TOKEN
  const rt = readRuntime()
  return typeof rt?.token === 'string' ? rt.token : ''
}

function endpoint() {
  if (explicitUrl) return `${explicitUrl.replace(/\/$/, '')}/mcp`
  const rt = readRuntime()
  if (!rt || !rt.port) {
    // 环境问题（不是用法错误）：退出码 1，提示怎么修
    die('找不到 caldesk 的运行信息，请先启动 caldesk 桌面端（或用 --url 指定地址）。')
  }
  return `http://127.0.0.1:${rt.port}/mcp`
}

/**
 * 统一的失败出口。
 * --json 模式下也输出 JSON（给 Agent 解析），非 JSON 模式打中文提示；一律走 stderr + 非 0 退出。
 */
function die(message, { code = 1, detail = null } = {}) {
  if (asJson) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: { message, code, detail } }, null, 2) + '\n'
    )
  } else {
    process.stderr.write(message + '\n')
  }
  process.exit(code)
}

function usageFail(message) {
  die(`${message}\n用 cal --help 查看用法。`, { code: 2 })
}

function authHeaders(extra = {}) {
  const t = token()
  return { ...extra, ...(t ? { authorization: `Bearer ${t}` } : {}) }
}

async function rpc(name, args = {}) {
  let res
  const url = endpoint()
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
  } catch (err) {
    die(`连接 caldesk 失败：${err.message}\n请确认桌面端正在运行（目标 ${url}）。`)
  }
  if (!res.ok) {
    const text = await res.text()
    die(`请求失败（HTTP ${res.status}）：${text}`)
  }
  const payload = await res.json()
  if (payload.error) die(`接口错误（${payload.error.code}）：${payload.error.message}`)
  const result = payload.result
  const text = result?.content?.map((c) => c.text).join('\n') ?? ''
  if (result?.isError) die(text)
  return text
}

async function postRaw(pathWithQuery) {
  const base = endpoint().replace(/\/mcp$/, '')
  let res
  try {
    res = await fetch(base + pathWithQuery, { method: 'POST', headers: authHeaders() })
  } catch (err) {
    die(`连接 caldesk 失败：${err.message}（目标 ${base}）`)
  }
  if (!res.ok) {
    die(`请求失败（HTTP ${res.status}）：${await res.text()}`)
  }
  const payload = await res.json()
  return payload
}

function print(text) {
  if (asJson) {
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2))
      return
    } catch {
      /* 非 JSON 原样输出 */
    }
  }
  console.log(text)
}

/** 已经拿到结构化的结果，按 --json 决定输出 JSON 还是人话 */
function emit(data, human) {
  if (asJson) console.log(JSON.stringify(data, null, 2))
  else console.log(typeof human === 'function' ? human(data) : human)
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function monthRange() {
  const d = new Date()
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  const p = (n) => String(n).padStart(2, '0')
  const fmt = (x) => `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
  return [fmt(first), fmt(last)]
}

/** 取开关的值；缺值（下一个也是开关或到头）直接报用法错误，别把 `--to` 当日期用 */
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) usageFail(`--${name} 缺少取值`)
  return v
}

/** 行号：必须是非负整数。原来 Number('abc') = NaN → 被服务端当成 0，会误改第 0 行 */
function parseIndex(raw) {
  if (!/^\d+$/.test(String(raw))) usageFail(`行号必须是非负整数，收到「${raw}」`)
  return Number(raw)
}

function usage() {
  return `cal — caldesk 命令行客户端

  cal list                              列出视图
  cal day [日期]                        查看某天任务
  cal add <日期> <文本>                 追加任务
  cal done <日期> <行号>                标记完成
  cal undone <日期> <行号>              取消完成
  cal rm <日期> <行号>                  删除一行
  cal events [--from] [--to] [--kind]   查询事件
  cal new-event <标题> [--kind] [--start] [--rrule] [--target]
  cal del-event <id>                    删除事件
  cal migrate [--from 日期] [--to 日期] [--command 程序] [--arg 参数…]
                                        从旧版「日历清单」导入（需其 AI 访问已开启）
  cal search <关键词>                   全文搜索

全局选项：
  --json            输出原始 JSON（失败时也是 JSON，便于 Agent 解析）
  --url <地址>      覆盖端口自动发现，如 http://127.0.0.1:19283
  --token <令牌>    覆盖 runtime.json 里的访问令牌
  -h, --help        显示本帮助

退出码：0 成功；1 运行/接口错误；2 用法错误。`
}

const [cmd, ...rest] = positional

if (helpWanted) {
  console.log(usage())
  process.exit(0)
}

switch (cmd) {
  case 'list':
    print(await rpc('calendar_list'))
    break

  case 'day': {
    const date = rest[0] ?? today()
    const data = JSON.parse(await rpc('items_get', { date }))
    if (asJson) console.log(JSON.stringify(data, null, 2))
    else if (!data.lines?.length) console.log(`${date} 没有任务`)
    else {
      data.lines.forEach((line, i) => {
        const done = /^~~.*~~$/.test(line.trim())
        console.log(`${String(i).padStart(2)}  ${done ? '✓' : ' '}  ${line.replace(/~~/g, '')}`)
      })
    }
    break
  }

  case 'add': {
    const [date, ...words] = rest
    if (!date || words.length === 0) usageFail('用法：cal add <YYYY-MM-DD> <文本...>')
    const data = JSON.parse(await rpc('items_append_line', { date, text: words.join(' ') }))
    emit(data, `已添加到 ${date}（共 ${data.lines?.length ?? 0} 行）`)
    break
  }

  case 'done':
  case 'undone': {
    const [date, rawIndex] = rest
    if (!date || rawIndex === undefined) usageFail(`用法：cal ${cmd} <YYYY-MM-DD> <行号>`)
    const index = parseIndex(rawIndex)
    const data = JSON.parse(await rpc('item_line_set_done', { date, index, done: cmd === 'done' }))
    emit(data, `已${cmd === 'done' ? '完成' : '取消完成'} ${date} 第 ${index} 行`)
    break
  }

  case 'rm': {
    const [date, rawIndex] = rest
    if (!date || rawIndex === undefined) usageFail('用法：cal rm <YYYY-MM-DD> <行号>')
    const index = parseIndex(rawIndex)
    const data = JSON.parse(await rpc('item_line_delete', { date, index }))
    emit(data, `已删除 ${date} 第 ${index} 行`)
    break
  }

  case 'events': {
    const [defFrom, defTo] = monthRange()
    const from = flag('from', defFrom)
    const to = flag('to', defTo)
    const kind = flag('kind', 'all')
    if (!['all', 'task', 'reminder', 'countdown'].includes(kind)) {
      usageFail(`--kind 只能是 all / task / reminder / countdown，收到「${kind}」`)
    }
    // 默认跨所有视图：只查第一个视图会让人以为「事件丢了」
    const calendars = JSON.parse(await rpc('calendar_list'))
    const list = []
    for (const cal of calendars) {
      const text = await rpc('events_query', { calendar_id: cal.id, from, to, kind })
      for (const e of JSON.parse(text)) list.push({ ...e, calendar: cal.name })
    }
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

    if (asJson) {
      console.log(JSON.stringify(list, null, 2))
    } else if (list.length === 0) {
      console.log(`${from} ~ ${to} 没有事件`)
    } else {
      for (const e of list) {
        const mark = e.done ? '✓' : '·'
        const extra = e.rrule ? ` [${e.rrule}]` : ''
        console.log(`${e.date}  ${mark}  ${e.kind.padEnd(9)} [${e.calendar}] ${e.title}${extra}`)
      }
    }
    break
  }

  case 'new-event': {
    const title = rest.join(' ')
    if (!title) usageFail('用法：cal new-event <标题> [--kind task] [--start 日期] [--rrule 规则] [--target 日期]')
    const args = {
      title,
      kind: flag('kind', 'task'),
      start: flag('start', today())
    }
    const rrule = flag('rrule')
    const target = flag('target')
    if (rrule) args.rrule = rrule
    if (target) args.target_date = target
    print(await rpc('event_create', args))
    break
  }

  case 'del-event': {
    const [id] = rest
    if (!id) usageFail('用法：cal del-event <id>')
    const data = JSON.parse(await rpc('event_delete', { id }))
    emit(data, '已删除事件')
    break
  }

  case 'migrate': {
    const [defFrom, defTo] = monthRange()
    const from = flag('from', defFrom)
    const to = flag('to', defTo)
    const command = flag('command')
    // 用可重复的 --arg 传参，避免命令行里写 JSON（各 shell 转义规则不同，极易出错）
    const argValues = []
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--arg' && argv[i + 1] && !argv[i + 1].startsWith('--')) argValues.push(argv[i + 1])
    }
    let path = `/migrate/run?from=${from}&to=${to}`
    if (command) {
      path += `&command=${encodeURIComponent(command)}`
      if (argValues.length > 0) path += `&args=${encodeURIComponent(JSON.stringify(argValues))}`
    }
    const result = await postRaw(path)
    if (result && result.ok === false && result.error) {
      die(`迁移失败：${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`)
    }
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'search': {
    const query = rest.join(' ')
    if (!query) usageFail('用法：cal search <关键词>')
    const text = await rpc('search', { query })
    if (asJson) {
      print(text)
    } else {
      const hits = JSON.parse(text)
      if (hits.length === 0) console.log('没有匹配结果')
      else for (const h of hits) console.log(`${h.date}  ${h.type.padEnd(5)} [${h.calendarName}] ${h.title}`)
    }
    break
  }

  default:
    if (cmd) {
      process.stderr.write(`未知子命令：${cmd}\n\n${usage()}\n`)
      process.exit(2)
    }
    console.log(usage())
    process.exit(0)
}
