/**
 * 一键跑完整验收。
 *
 * 顺序按「便宜且独立 → 贵且有依赖」排：
 *   1. 静态类型检查（主进程/渲染层、Worker）
 *   2. 纯函数与数据层（rrule、rrule 跨端一致性、日历网格、快照、数据层、主进程 IPC）
 *   3. 设计契约
 *   4. 需要起进程的（MCP、CLI、同步、桌面 UI、手机 UI）
 *
 * 用法：
 *   node scripts/verify-all.mjs                 # 全部
 *   node scripts/verify-all.mjs --fast          # 只跑静态 + 纯函数
 *   node scripts/verify-all.mjs --only mcp,cli  # 只跑指定几项（按 name 匹配）
 *   node scripts/verify-all.mjs --list          # 只列出用例
 *
 * 退出码：全部通过 0；有失败 1；脚本缺失算跳过（不计失败）。
 *
 * 实现说明：一律绕过 `npm run`，直接 spawn `node <bin> ...`。
 * 原因是 Windows 上 Node 18.20+/20.12+ 禁止不带 shell 直接 spawn `.cmd`，
 * 而 `spawn('npm.cmd', ..., {shell:true})` 又会触发 DEP0190（参数不转义）。
 * 直接调用 node + 真正的 js 入口既能跨平台，也没有 shell 注入面。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const fast = argv.includes('--fast')
const listOnly = argv.includes('--list')
const onlyIdx = argv.indexOf('--only')
const only =
  onlyIdx >= 0
    ? new Set(
        (argv[onlyIdx + 1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null

const TSC = 'node_modules/typescript/bin/tsc'

const CASES = [
  // ---- 静态检查 ----
  {
    name: 'typecheck:node',
    group: 'static',
    args: [TSC, '--noEmit', '-p', 'tsconfig.node.json'],
    timeout: 300_000
  },
  {
    name: 'typecheck:web',
    group: 'static',
    args: [TSC, '--noEmit', '-p', 'tsconfig.web.json'],
    timeout: 300_000
  },
  {
    name: 'typecheck:worker',
    group: 'static',
    cwd: 'worker',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
    timeout: 300_000
  },

  // ---- 纯函数 / 数据层 ----
  { name: 'rrule', group: 'unit', script: 'scripts/verify-rrule.mjs', timeout: 120_000 },
  {
    name: 'rrule-parity',
    group: 'unit',
    script: 'scripts/verify-rrule-parity.mjs',
    timeout: 180_000,
    optional: true
  },
  { name: 'calendar', group: 'unit', script: 'scripts/verify-calendar.mjs', timeout: 120_000 },
  { name: 'snapshots', group: 'unit', script: 'scripts/verify-snapshots.mjs', timeout: 180_000 },
  { name: 'db', group: 'unit', script: 'scripts/verify-db.mjs', timeout: 300_000, optional: true },
  {
    name: 'db-main',
    group: 'unit',
    script: 'scripts/verify-db-main.mjs',
    timeout: 180_000,
    optional: true
  },

  // ---- 设计契约 ----
  { name: 'contract', group: 'contract', script: 'scripts/contract.mjs', timeout: 120_000 },

  // ---- 同步后端（脚本自带 wrangler dev 启停，用临时 D1）----
  { name: 'sync-core', group: 'backend', script: 'scripts/verify-sync.mjs', timeout: 120_000 },
  { name: 'auth', group: 'backend', script: 'scripts/verify-auth.mjs', timeout: 420_000, optional: true },
  {
    name: 'worker-api',
    group: 'backend',
    script: 'scripts/verify-worker-api.mjs',
    timeout: 420_000,
    optional: true
  },

  // ---- 需要起进程 ----
  { name: 'mcp', group: 'runtime', script: 'scripts/verify-mcp.mjs', timeout: 420_000, optional: true },
  { name: 'cli', group: 'runtime', script: 'scripts/verify-cli.mjs', timeout: 420_000, optional: true },
  {
    name: 'sync',
    group: 'runtime',
    script: 'scripts/verify-sync-e2e.mjs',
    timeout: 600_000,
    optional: true
  },
  // 跨端契约：桌面端 /sync/push ↔ 手机端 /api/*，自己起本地 Worker
  {
    name: 'interop',
    group: 'runtime',
    script: 'scripts/verify-interop.mjs',
    timeout: 420_000,
    optional: true
  },
  { name: 'desktop-ui', group: 'runtime', script: 'scripts/ui-desktop.mjs', timeout: 600_000, optional: true },
  // 浮窗 1天/1周/1月 + 可调尺寸（独立 Electron 实例，自己写跨天数据）
  {
    name: 'mini-range',
    group: 'runtime',
    script: 'scripts/verify-mini-range.mjs',
    timeout: 420_000,
    optional: true
  },
  {
    name: 'mobile-ui',
    group: 'runtime',
    script: 'scripts/mobile-verify.mjs',
    timeout: 600_000,
    optional: true
  }
]

if (listOnly) {
  for (const c of CASES) {
    const cmd = c.script ? `node ${c.script}` : `(cd ${c.cwd ?? '.'} && node ${c.args.join(' ')})`
    console.log(`${c.group.padEnd(9)} ${c.name.padEnd(18)} ${cmd}`)
  }
  process.exit(0)
}

const selected = CASES.filter((c) => {
  if (only) return only.has(c.name)
  if (fast) return c.group === 'static' || c.group === 'unit'
  return true
})

function runCase(c) {
  return new Promise((resolve) => {
    const started = Date.now()
    const cwd = c.cwd ? join(root, c.cwd) : root
    const args = c.script ? [join(root, c.script)] : c.args
    if (c.script && !existsSync(join(root, c.script))) {
      resolve({ ...c, status: 'missing', ms: 0 })
      return
    }
    const child = spawn(process.execPath, args, {
      cwd,
      // 关键：本机环境中 ELECTRON_RUN_AS_NODE=1 是默认打开的，
      // 它会污染任何被 spawn 的 node/electron 子进程，必须显式清掉。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, c.timeout ?? 300_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ...c, status: 'error', ms: Date.now() - started, out, err: String(e) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({
        ...c,
        status: code === 0 ? 'pass' : 'fail',
        code,
        ms: Date.now() - started,
        out,
        err
      })
    })
  })
}

const results = []
for (const c of selected) {
  process.stdout.write(`▶ ${c.name} … `)
  const r = await runCase(c)
  results.push(r)
  const label =
    r.status === 'pass'
      ? '✅ pass'
      : r.status === 'missing'
        ? `⏭ skip（不存在：${c.script}）`
        : r.status === 'error'
          ? '💥 error'
          : `❌ fail（exit ${r.code}）`
  console.log(`${label}  ${r.ms ? (r.ms / 1000).toFixed(1) + 's' : ''}`)
  if (r.status === 'fail' || r.status === 'error') {
    const tail = ((r.err || '') + (r.out || '')).trim().split(/\r?\n/).slice(-25).join('\n')
    if (tail) console.log(tail.replace(/^/gm, '    │ '))
  }
}

const pass = results.filter((r) => r.status === 'pass')
const fail = results.filter((r) => r.status === 'fail' || r.status === 'error')
const skipped = results.filter((r) => r.status === 'missing')

console.log('\n' + '─'.repeat(72))
console.log(`通过 ${pass.length} / 失败 ${fail.length} / 跳过 ${skipped.length}（共 ${results.length}）`)
if (skipped.length) console.log('跳过：' + skipped.map((r) => `${r.name}(${r.script})`).join('、'))
if (fail.length) console.log('失败：' + fail.map((r) => r.name).join('、'))
console.log('─'.repeat(72))
process.exit(fail.length ? 1 : 0)
