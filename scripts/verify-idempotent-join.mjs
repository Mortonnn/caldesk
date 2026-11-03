/**
 * 验证 Worker 的 join 幂等分支：同一设备重复 join 时，
 * 服务端应该更新 secret 并返回 accountId。
 */
import { readFileSync } from 'node:fs'

const BASE = 'https://your-worker.example.com'
const deviceId = process.argv[2]
const deviceSecret = process.argv[3]

if (!deviceId || !deviceSecret) {
  console.error('用法：node scripts/verify-idempotent-join.mjs <deviceId> <deviceSecret>')
  process.exit(1)
}

// 先拿一个新的 code（由 PC 端生成）；这里直接用手机当前已有的身份去试
// 1) 旧 secret 应该还能用（说明服务器还没更新 secret）
const r1 = await fetch(`${BASE}/api/calendars`, {
  headers: { authorization: `Bearer ${deviceId}.${deviceSecret}` }
})
console.log(`旧 secret 调 /api/calendars → ${r1.status}`)

// 2) 换一个 secret 再 join，服务器应该接受并更新
const newSecret = 'a'.repeat(64)
const code = process.argv[4] ?? ''
if (!code) {
  console.log('（没给配对码，跳过 join 测试）')
  process.exit(0)
}
const r2 = await fetch(`${BASE}/pair/join`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    pairId: '',
    code,
    deviceId,
    accountSecret: newSecret,
    deviceName: '这台手机'
  })
})
console.log(`join（带新 secret）→ ${r2.status} ${await r2.text()}`)

// 3) 新 secret 现在应该能用了
const r3 = await fetch(`${BASE}/api/calendars`, {
  headers: { authorization: `Bearer ${deviceId}.${newSecret}` }
})
console.log(`新 secret 调 /api/calendars → ${r3.status}`)

// 4) 旧 secret 应该失效
const r4 = await fetch(`${BASE}/api/calendars`, {
  headers: { authorization: `Bearer ${deviceId}.${deviceSecret}` }
})
console.log(`旧 secret 再调 → ${r4.status}`)
