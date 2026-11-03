#!/usr/bin/env node
/**
 * 模拟旧版「日历清单」的 MCP 服务，仅用于验证迁移器。
 * 协议形状与实测的 desktopcal-mcp.exe 一致：换行分隔的 JSON-RPC。
 */
import { createInterface } from 'node:readline'

const CALENDARS = [
  { id: 'c-work', name: '工作', color: '#5b8cff' },
  { id: 'c-life', name: '生活', color: '#3ddc97' }
]

const CELLS = {
  'c-work|2026-11-02': '开周会\n写周报\n~~提交报销~~',
  'c-work|2026-11-05': '评审设计稿',
  'c-life|2026-11-03': '买菜\n取快递'
}

const EVENTS = {
  'c-work': [
    {
      id: 'e1',
      title: '每周例会',
      kind: 'task',
      date: '2026-11-02',
      rrule: 'FREQ=WEEKLY;BYDAY=MO'
    },
    {
      id: 'e2',
      title: '年会倒计时',
      kind: 'countdown',
      date: '2026-12-20',
      target_date: '2026-12-20'
    }
  ],
  'c-life': [
    { id: 'e3', title: '交房租', kind: 'reminder', date: '2026-11-05' }
  ]
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function errorReply(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { message } }) + '\n')
}

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = msg

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-desktopcal', version: '0.0.1' }
    })
    return
  }
  if (method === 'notifications/initialized') return

  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === 'calendar_list') {
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ calendars: CALENDARS, current_calendar_id: 'c-work' }) }]
      })
      return
    }
    if (name === 'items_get') {
      const key = `${args.calendar_id}|${args.date}`
      const text = CELLS[key] ?? ''
      reply(id, { content: [{ type: 'text', text: JSON.stringify({ date: args.date, text, lines: text ? text.split('\n') : [] }) }] })
      return
    }
    if (name === 'events_query') {
      const rows = EVENTS[args.calendar_id] ?? []
      reply(id, { content: [{ type: 'text', text: JSON.stringify(rows) }] })
      return
    }
    errorReply(id, `mock 未实现工具：${name}`)
    return
  }

  errorReply(id, `mock 未实现方法：${method}`)
})
