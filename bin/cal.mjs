#!/usr/bin/env node
/**
 * cal — caldesk 命令行客户端。
 *
 * 需要 caldesk 桌面端正在运行；通过其本地 MCP 服务（127.0.0.1 随机端口）通信。
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
 *
 * 全局：--json 输出原始 JSON；--url http://127.0.0.1:PORT 覆盖自动发现
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const urlFlag = argv.indexOf('--url')
const explicitUrl = urlFlag >= 0 ? argv[urlFlag + 1] : null

// 成对剔除「--flag 值」，否则 --rrule 的取值会被当成位置参数混进标题里
const BOOL_FLAGS = new Set(['--json'])
const dropped = new Set()
for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  if (!token.startsWith('--')) continue
  dropped.add(i)
  if (!BOOL_FLAGS.has(token) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
    dropped.add(i + 1)
  }
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

function endpoint() {
  if (explicitUrl) return `${explicitUrl.replace(/\/$/, '')}/mcp`
  let rt
  try {
    rt = JSON.parse(readFileSync(runtimePath(), 'utf-8'))
  } catch {
    fail('找不到 caldesk 的运行信息，请先启动 caldesk 桌面端（或用 --url 指定地址）。')
  }
  return `http://127.0.0.1:${rt.port}/mcp`
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function rpc(name, args = {}) {
  let res
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
  } catch (err) {
    fail(`连接 caldesk 失败：${err.message}\n请确认桌面端正在运行。`)
  }
  if (!res.ok) {
    const text = await res.text()
    fail(`请求失败（${res.status}）：${text}`)
  }
  const payload = await res.json()
  if (payload.error) fail(`错误：${payload.error.message}`)
  const result = payload.result
  const text = result?.content?.map((c) => c.text).join('\n') ?? ''
  if (result?.isError) fail(text)
  return text
}

async function postRaw(pathWithQuery) {
  const base = endpoint().replace(/\/mcp$/, '')
  let res
  try {
    res = await fetch(base + pathWithQuery, { method: 'POST' })
  } catch (err) {
    fail(`连接 caldesk 失败：${err.message}`)
  }
  const payload = await res.json()
  if (payload.error) fail(`错误：${payload.error}`)
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

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}

const [cmd, ...rest] = positional

switch (cmd) {
  case 'list':
    print(await rpc('calendar_list'))
    break

  case 'day': {
    const date = rest[0] ?? today()
    const text = await rpc('items_get', { date })
    if (asJson) {
      print(text)
    } else {
      const data = JSON.parse(text)
      if (!data.lines?.length) {
        console.log(`${date} 没有任务`)
      } else {
        data.lines.forEach((line, i) => {
          const done = /^~~.*~~$/.test(line.trim())
          console.log(`${String(i).padStart(2)}  ${done ? '✓' : ' '}  ${line.replace(/~~/g, '')}`)
        })
      }
    }
    break
  }

  case 'add': {
    const [date, ...words] = rest
    if (!date || words.length === 0) fail('用法：cal add <YYYY-MM-DD> <文本...>')
    await rpc('items_append_line', { date, text: words.join(' ') })
    console.log(`已添加到 ${date}`)
    break
  }

  case 'done':
  case 'undone': {
    const [date, index] = rest
    if (!date || index === undefined) fail(`用法：cal ${cmd} <YYYY-MM-DD> <行号>`)
    await rpc('item_line_set_done', { date, index: Number(index), done: cmd === 'done' })
    console.log(`已${cmd === 'done' ? '完成' : '取消完成'} ${date} 第 ${index} 行`)
    break
  }

  case 'rm': {
    const [date, index] = rest
    if (!date || index === undefined) fail('用法：cal rm <YYYY-MM-DD> <行号>')
    await rpc('item_line_delete', { date, index: Number(index) })
    console.log(`已删除 ${date} 第 ${index} 行`)
    break
  }

  case 'events': {
    const [defFrom, defTo] = monthRange()
    const from = flag('from', defFrom)
    const to = flag('to', defTo)
    const kind = flag('kind', 'all')
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
    if (!title) fail('用法：cal new-event <标题> [--kind task] [--start 日期] [--rrule 规则]')
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
    if (!id) fail('用法：cal del-event <id>')
    await rpc('event_delete', { id })
    console.log('已删除事件')
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
    console.log(JSON.stringify(result, null, 2))
    break
  }

  case 'search': {
    const query = rest.join(' ')
    if (!query) fail('用法：cal search <关键词>')
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
    console.log(`cal — caldesk 命令行客户端

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

全局选项：--json 输出原始 JSON
`)
    process.exit(cmd ? 1 : 0)
}
