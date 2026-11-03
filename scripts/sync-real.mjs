/**
 * 用真实 userData 目录跑一次同步，并打印报告。
 * 用法：node scripts/sync-real.mjs [--full]
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const full = process.argv.includes('--full')
const userData = join(homedir(), 'AppData', 'Roaming', 'caldesk')
const exe = join(homedir(), 'AppData', 'Local', 'Programs', 'caldesk', 'caldesk.exe')

const identity = JSON.parse(readFileSync(join(userData, 'identity.json'), 'utf-8'))
console.log('账号：', identity.accountId)
console.log('设备：', identity.deviceId)
console.log('服务器：', identity.serverUrl)

const args = [`--user-data-dir=${userData}`, '--sync-once']
if (full) args.push('--sync-full')

const r = spawnSync(exe, args, {
  encoding: 'utf-8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  timeout: 120000
})
console.log('--- stdout ---')
console.log(r.stdout)
if (r.stderr) console.log('--- stderr ---\n' + r.stderr.slice(0, 2000))
