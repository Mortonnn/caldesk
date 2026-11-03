#!/usr/bin/env node
/**
 * cal-mcp — MCP stdio 桥。
 *
 * 给只支持 stdio 的 MCP 客户端使用（Codex、Claude Desktop 等）：
 * 它把 stdin 的 JSON-RPC 转发给 caldesk 的本地服务，再把应答写回 stdout。
 *
 * 配置示例（Codex config.toml）：
 *   [mcp_servers.caldesk]
 *   command = "node"
 *   args = ["<路径>/caldesk/bin/cal-mcp.mjs"]
 *
 * 说明：不输出任何日志到 stdout（会污染协议），日志一律走 stderr。
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

function endpoint() {
  if (process.env.CALDESK_URL) return `${process.env.CALDESK_URL.replace(/\/$/, '')}/mcp`
  let rt
  try {
    rt = JSON.parse(readFileSync(runtimePath(), 'utf-8'))
  } catch {
    process.stderr.write(
      'cal-mcp: 找不到 caldesk 的运行信息。请先启动 caldesk 桌面端，或设置 CALDESK_URL。\n'
    )
    process.exit(1)
  }
  return `http://127.0.0.1:${rt.port}/mcp`
}

async function forward(line) {
  const url = endpoint()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: line
    })
  } catch (err) {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: `无法连接 caldesk：${err.message}` }
    })
  }
  if (res.status === 202) return null
  const text = await res.text()
  return text.trim() || null
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

for await (const line of rl) {
  const trimmed = line.trim()
  if (!trimmed) continue
  // 逐条串行处理，保证应答顺序与请求顺序一致
  const reply = await forward(trimmed)
  if (reply) {
    process.stdout.write(reply + '\n')
  }
}
