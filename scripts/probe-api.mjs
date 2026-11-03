/**
 * 用手机（或任意设备）的凭据直接打服务端 API，看返回什么。
 * 用法：node scripts/probe-api.mjs <deviceId> <deviceSecret>
 */
import { readFileSync } from 'node:fs'

const [deviceId, deviceSecret] = process.argv.slice(2)
if (!deviceId || !deviceSecret) {
  console.error('用法：node scripts/probe-api.mjs <deviceId> <deviceSecret>')
  process.exit(1)
}

const BASE = 'https://your-worker.example.com'
const headers = { authorization: `Bearer ${deviceId}.${deviceSecret}` }

async function get(path) {
  const res = await fetch(BASE + path, { headers })
  const text = await res.text()
  console.log(`${res.status} ${path}  ${text.slice(0, 400)}`)
  return res
}

await get('/api/calendars')
await get('/api/cells?from=2026-10-20&to=2026-12-05')
await get('/api/events?from=2026-10-20&to=2026-12-05')
await get('/devices')
