#!/usr/bin/env node
/**
 * cal-mcp — MCP stdio 桥。
 *
 * 给只支持 stdio 的 MCP 客户端使用（Codex、Claude Desktop、Cursor 等）：
 * 它把 stdin 的 JSON-RPC 转给 caldesk 的本地服务（固定 127.0.0.1:19283，
 * 端口与可选令牌从 runtime.json 发现），再把应答写回 stdout。
 *
 * 配置示例（Codex config.toml）：
 *   [mcp_servers.caldesk]
 *   command = "node"
 *   args = ["<路径>/caldesk/bin/cal-mcp.mjs"]
 *
 * 说明：
 *  - stdout 只写 JSON-RPC 报文，日志一律走 stderr（console.log 会污染协议）；
 *  - 逐条串行转发，保证应答顺序；上游挂掉时回一条带原 id 的 JSON-RPC 错误，不会静默挂死。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

function runtimePath() {
  const env = process.env.CALDESK_RUNTIME
  if (env) return env
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'caldesk', 'runtime.json')
  }
  return join(homedir(), '.config', 'caldesk', 'runtime.json')
}

// 每次转发都重读 runtime.json：桌面端重启换了端口/令牌时桥能自动跟上
function runtimeInfo() {
  try {
    return JSON.parse(readFileSync(runtimePath(), 'utf-8'))
  } catch {
    return null
  }
}

function endpoint(rt) {
  if (process.env.CALDESK_URL) return `${process.env.CALDESK_URL.replace(/\/$/, '')}/mcp`
  if (!rt || !rt.port) return null
  return `http://127.0.0.1:${rt.port}/mcp`
}

function tokenOf(rt) {
  if (process.env.CALDESK_TOKEN) return process.env.CALDESK_TOKEN
  return typeof rt?.token === 'string' ? rt.token : ''
}

/** 取报文里的 id（通知没有 id，出错时不能凭空造一个应答） */
function idOf(line) {
  try {
    const msg = JSON.parse(line)
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      return Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : undefined
    }
  } catch {
    /* 交给上游去报解析错误 */
  }
  return undefined
}

function writeReply(value) {
  if (value === null || value === undefined) return
  process.stdout.write(value + '\n')
}

async function forward(line) {
  const rt = runtimeInfo()
  const url = endpoint(rt)
  if (!url) {
    throw new Error(
      '找不到 caldesk 的运行信息。请先启动 caldesk 桌面端，或设置 CALDESK_URL / CALDESK_RUNTIME。'
    )
  }
  const token = tokenOf(rt)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: line
    })
  } catch (err) {
    throw new Error(`无法连接 caldesk（${url}）：${err.cause?.message ?? err.message}`)
  }
  if (res.status === 202 || res.status === 204) return null
  const text = (await res.text()).trim()
  if (!text) return null
  if (!res.ok) {
    // 上游的业务错误本身就是 JSON-RPC error，透传；否则包一层，别让客户端拿到裸文本
    try {
      const parsed = JSON.parse(text)
      if (parsed && (parsed.jsonrpc || parsed.error)) return JSON.stringify(parsed)
    } catch {
      /* 非 JSON */
    }
    throw new Error(`caldesk 返回 HTTP ${res.status}：${text.slice(0, 300)}`)
  }
  return text
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

let chain = Promise.resolve()
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const id = idOf(trimmed)
  // 逐条串行处理，保证应答顺序与请求顺序一致
  chain = chain.then(async () => {
    try {
      writeReply(await forward(trimmed))
    } catch (err) {
      process.stderr.write(`cal-mcp: ${err.message}\n`)
      if (id === undefined) return // 通知没有回包通道
      writeReply(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err.message }
        })
      )
    }
  })
})

rl.on('close', () => {
  chain.then(() => process.exit(0))
})
