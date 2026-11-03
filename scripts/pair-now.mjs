/**
 * 生成一个配对二维码（走电脑的真实凭据），并把二维码文本打到控制台 + 存成文件。
 * 手机可以扫这个二维码，或者手动输入配对码。
 *
 * 用法：node scripts/pair-now.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const USER_DATA = join(homedir(), 'AppData', 'Roaming', 'caldesk')
const idPath = join(USER_DATA, 'identity.json')

if (!existsSync(idPath)) {
  console.error('本机还没身份，先跑 setup-local-account.mjs')
  process.exit(1)
}
const identity = JSON.parse(readFileSync(idPath, 'utf-8'))
const base = identity.serverUrl.replace(/\/$/, '')

const res = await fetch(`${base}/pair/start`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${identity.deviceId}.${identity.deviceSecret}`
  },
  body: '{}'
})
if (!res.ok) {
  console.error('发起配对失败:', res.status, (await res.text()).slice(0, 200))
  process.exit(1)
}
const { pairId, code, expiresAt } = await res.json()

const qrText = JSON.stringify({ v: 1, u: base, p: pairId, c: code })
writeFileSync(join(USER_DATA, 'pair-qr.txt'), qrText, 'utf-8')

console.log('配对码:', code)
console.log('二维码内容（可直接粘到手机"手动输入"模式，或用其它扫码工具扫这段）：')
console.log(qrText)
console.log('过期时间:', new Date(expiresAt).toLocaleString('zh-CN'))
console.log('已存:', join(USER_DATA, 'pair-qr.txt'))
