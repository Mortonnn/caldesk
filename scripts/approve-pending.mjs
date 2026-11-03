/**
 * 列出本机账号下的待批准设备，并批准指定名字的那台（默认全部批准）。
 *
 * 用法：node scripts/approve-pending.mjs [设备名关键字]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE_DEFAULT = 'https://your-worker.example.com'
const USER_DATA = join(homedir(), 'AppData', 'Roaming', 'caldesk')
const identity = JSON.parse(readFileSync(join(USER_DATA, 'identity.json'), 'utf-8'))
const base = (identity.serverUrl || BASE_DEFAULT).replace(/\/$/, '')
const token = `${identity.deviceId}.${identity.deviceSecret}`

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

const keyword = process.argv[2] ?? ''
const list = await api('/pair/pending')
const devices = list.json?.devices ?? []
console.log('待批准设备：')
if (!devices.length) console.log('  （没有）')
for (const d of devices) console.log(`  - ${d.name}  (${d.deviceId})`)

const targets = keyword ? devices.filter((d) => d.name.includes(keyword)) : devices
if (!targets.length) {
  console.log(keyword ? `没有名字包含「${keyword}」的设备` : '没有待批准的设备')
  process.exit(0)
}

// 批准需要一个 pairId：从 pair-qr.txt 里读（当前这次配对）
let pairId = ''
try {
  pairId = JSON.parse(readFileSync(join(USER_DATA, 'pair-qr.txt'), 'utf-8')).p ?? ''
} catch { /* 没有就用服务端查 */ }

for (const d of targets) {
  const r = await api('/pair/approve', { method: 'POST', body: { pairId, deviceId: d.deviceId } })
  console.log(`批准 ${d.name} → ${r.status} ${r.text.slice(0, 120)}`)
}
