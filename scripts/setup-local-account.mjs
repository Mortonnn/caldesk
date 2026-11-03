/**
 * 给本机（真实 userData 目录）建一个正式账号：
 *   - 生成账号 + 写入 identity.json
 *   - 之后桌面端设置里显示的就是这个账号，可以直接出配对二维码
 *
 * 用法：node scripts/setup-local-account.mjs [serverUrl]
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = (process.argv[2] || 'https://caldesk.ilikeu.cc.cd').replace(/\/$/, '')
const USER_DATA = join(homedir(), 'AppData', 'Roaming', 'caldesk')

const hex = (n) =>
  [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('')

async function main() {
  const deviceId = crypto.randomUUID()
  const deviceSecret = hex(32)
  const deviceName = '我的电脑'

  const res = await fetch(`${BASE}/account/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite: '',
      accountName: '我的日历',
      deviceId,
      accountSecret: deviceSecret,
      deviceName
    })
  })
  if (!res.ok) {
    console.error('建账号失败:', res.status, (await res.text()).slice(0, 200))
    process.exit(1)
  }
  const { accountId } = await res.json()
  console.log('账号已创建:', accountId)

  mkdirSync(USER_DATA, { recursive: true })
  const idPath = join(USER_DATA, 'identity.json')
  const identity = {
    accountId,
    deviceId,
    deviceSecret,
    deviceName,
    serverUrl: BASE,
    createdAt: Date.now()
  }
  writeFileSync(idPath, JSON.stringify(identity, null, 2), { mode: 0o600 })
  console.log('已写入:', idPath)
  console.log('设备:', deviceId)

  // 顺便验证凭据可用
  const devices = await fetch(`${BASE}/devices`, {
    headers: { authorization: `Bearer ${deviceId}.${deviceSecret}` }
  })
  console.log('凭据验证 →', devices.status, devices.status === 200 ? '正常' : '异常')
}

main().catch((e) => { console.error(e); process.exit(2) })
