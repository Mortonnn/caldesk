/**
 * 跨端副本一致性守卫。
 *
 * 背景：Worker 侧不能 import 仓库根的 `src/shared/*`（Cloudflare Workers Builds 的
 * 构建根目录是 `worker/`，构建上下文里没有仓库根的 src/），所以这两处是**手工维护的副本**：
 *
 *   src/shared/rrule.ts   ↔  worker/src/rrule.ts     （重复规则展开）
 *   src/shared/types.ts   ↔  worker/src/celltext.ts  （日格文本 ↔ 行）
 *
 * 副本本身是合理的设计，但**没有任何机制保证它们还一致**。一旦有人只改了桌面端那份，
 * 手机端（读 Worker 在服务端展开的重复事件）就会和电脑端显示不同的日期 —— 这类 bug
 * 不会报错、只会「手机上少了一次周会」，极难发现。
 *
 * 本脚本就是那个机制：只做行为对比，不要求两份源码逐字相同。
 *
 * 运行：node scripts/verify-rrule-parity.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'caldesk-parity-'))
const gen = join(tmp, 'gen')
mkdirSync(gen, { recursive: true })

let failures = 0
function ok(cond, msg) {
  if (cond) {
    console.log('  ✓', msg)
    return
  }
  failures += 1
  console.error('  ✗', msg)
}
function section(t) {
  console.log(`\n[${t}]`)
}

/** 把一份 TS 转成 ESM 落到临时目录 */
function emit(srcRel, outRel) {
  const src = readFileSync(join(root, srcRel), 'utf-8')
  const js = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true
    }
  }).outputText
  writeFileSync(join(gen, outRel), js)
}

emit('src/shared/rrule.ts', 'shared-rrule.mjs')
emit('worker/src/rrule.ts', 'worker-rrule.mjs')
emit('worker/src/celltext.ts', 'worker-celltext.mjs')

const sharedRrule = await import(pathToFileURL(join(gen, 'shared-rrule.mjs')).href)
const workerRrule = await import(pathToFileURL(join(gen, 'worker-rrule.mjs')).href)
const workerCell = await import(pathToFileURL(join(gen, 'worker-celltext.mjs')).href)

/**
 * `src/shared/types.ts` 里除了日格文本工具还导出了一堆纯类型和领域常量，
 * 单独抽成只含那四个函数的临时模块，避免把整个 types 模块跑起来。
 */
const typesSrc = readFileSync(join(root, 'src/shared/types.ts'), 'utf-8')
const cellOnly = ts.transpileModule(
  typesSrc.slice(typesSrc.indexOf('/** 日格文本 <-> 行 的转换工具 */')),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true
    }
  }
).outputText.replace(/^export /gm, 'export ')
writeFileSync(join(gen, 'shared-cell.mjs'), cellOnly)
const sharedCell = await import(pathToFileURL(join(gen, 'shared-cell.mjs')).href)

const J = (v) => JSON.stringify(v)
const same = (a, b) => J(a) === J(b)

/* ------------------------------------------------------------------ */
section('1. RRULE 展开：src/shared/rrule.ts ↔ worker/src/rrule.ts')

const RULES = [
  null,
  'FREQ=DAILY',
  'FREQ=DAILY;INTERVAL=1',
  'FREQ=DAILY;INTERVAL=2',
  'FREQ=DAILY;INTERVAL=3;COUNT=10',
  'FREQ=DAILY;UNTIL=20261231',
  'FREQ=DAILY;UNTIL=20261231T235959Z',
  'FREQ=WEEKLY',
  'FREQ=WEEKLY;BYDAY=WE',
  'FREQ=WEEKLY;BYDAY=MO,WE,FR',
  'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
  'FREQ=WEEKLY;INTERVAL=3;BYDAY=SU',
  'FREQ=WEEKLY;BYDAY=MO;COUNT=5',
  'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
  'FREQ=MONTHLY',
  'FREQ=MONTHLY;BYMONTHDAY=31',
  'FREQ=MONTHLY;BYMONTHDAY=1',
  'FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=2',
  'FREQ=YEARLY',
  'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
  'FREQ=YEARLY;BYMONTHDAY=29',
  'FREQ=YEARLY;INTERVAL=4',
  // 脏输入：两边都必须给出同样的容错结果（通常是「只出现一次」或「不出现」）
  '',
  'freq=daily',
  'FREQ=DAILY;INTERVAL=0',
  'FREQ=DAILY;INTERVAL=-1',
  'FREQ=DAILY;INTERVAL=abc',
  'FREQ=HOURLY',
  'FREQ=WEEKLY;BYDAY=XX',
  'FREQ=WEEKLY;BYDAY=1MO',
  'FREQ=MONTHLY;BYMONTHDAY=32',
  'FREQ=MONTHLY;BYMONTHDAY=0',
  'COUNT=5',
  'RRULE:FREQ=DAILY',
  'FREQ=DAILY;COUNT=0',
  'FREQ=DAILY;COUNT=1',
  'FREQ=DAILY;;INTERVAL=2',
  ' FREQ=DAILY ',
  'FREQ=DAILY;INTERVAL=1000'
]

const STARTS = ['2026-01-01', '2026-02-28', '2024-02-29', '2026-11-07', '2026-01-31', '2026-12-31', '2025-03-15']
const WINDOWS = [
  ['2026-01-01', '2026-03-01'],
  ['2026-01-01', '2027-01-01'],
  ['2024-01-01', '2028-01-01'],
  ['2026-11-01', '2026-12-01'],
  ['2020-01-01', '2030-01-01']
]

function callExpand(mod, rule, start, from, to) {
  try {
    return { ok: true, dates: mod.expandRrule(rule, start, from, to) }
  } catch (e) {
    return { ok: false, thrown: String(e && e.message) }
  }
}

let checks = 0
const diffs = []
for (const rule of RULES) {
  for (const start of STARTS) {
    for (const [from, to] of WINDOWS) {
      checks += 1
      const a = callExpand(sharedRrule, rule, start, from, to)
      const b = callExpand(workerRrule, rule, start, from, to)
      if (!same(a, b)) {
        diffs.push({ rule: String(rule), start, from, to, shared: a, worker: b })
      }
    }
  }
}
ok(checks > 1000, `对比样本足够（${checks} 组：${RULES.length} 条规则 × ${STARTS.length} 个起始日 × ${WINDOWS.length} 个窗口）`)
ok(diffs.length === 0, `两端展开结果完全一致（${diffs.length} 组不一致）`)
if (diffs.length) {
  for (const d of diffs.slice(0, 10)) {
    console.error(`    · rule=${J(d.rule)} start=${d.start} [${d.from}~${d.to}]`)
    console.error(`      shared=${J(d.shared).slice(0, 160)}`)
    console.error(`      worker=${J(d.worker).slice(0, 160)}`)
  }
  if (diffs.length > 10) console.error(`    · 还有 ${diffs.length - 10} 组未列出`)
}

/* ------------------------------------------------------------------ */
section('2. 日格文本工具：src/shared/types.ts ↔ worker/src/celltext.ts')

const LINES = [
  '',
  ' ',
  '买牛奶',
  '~~买牛奶~~',
  '~~ a ~~',
  '~~a~~ 和 b',
  'a ~~b~~',
  '~~a~~\n~~b~~',
  '  ~~ 空格 ~~  ',
  '~~~三波浪~~~',
  '~~~~四波浪~~~~',
  '~~',
  '~~~~',
  '普通 ~~中间~~ 删除线',
  '中文\t制表符',
  '😀 emoji ~~完成~~'
]

let cellChecks = 0
let cellDiffs = 0
const cellDiffRows = []
const cmp = (fnName, ...args) => {
  cellChecks += 1
  let a
  let b
  try {
    a = { ok: true, v: sharedCell[fnName](...args) }
  } catch (e) {
    a = { ok: false, v: 'THROW:' + (e && e.message) }
  }
  try {
    b = { ok: true, v: workerCell[fnName](...args) }
  } catch (e) {
    b = { ok: false, v: 'THROW:' + (e && e.message) }
  }
  if (!same(a, b)) {
    cellDiffs += 1
    if (cellDiffRows.length < 10) {
      cellDiffRows.push({ fn: fnName, args: J(args), shared: J(a), worker: J(b) })
    }
  }
}

for (const line of LINES) {
  cmp('splitLines', line)
  cmp('isDoneLine', line)
  cmp('lineText', line)
  cmp('markDone', line, true)
  cmp('markDone', line, false)
}
ok(cellChecks > 50, `对比样本足够（${cellChecks} 次调用）`)
ok(cellDiffs === 0, `四个函数行为完全一致（${cellDiffs} 处不一致）`)
if (cellDiffs) {
  for (const r of cellDiffRows) console.error(`    · ${r.fn}(${r.args}) shared=${r.shared} worker=${r.worker}`)
}

/* ------------------------------------------------------------------ */
section('3. 两份副本的存在性说明（防止有人误删/误合并）')

for (const [rel, why] of [
  ['worker/src/rrule.ts', 'Worker 构建根目录是 worker/，无法 import 仓库根 src/shared/rrule.ts'],
  ['worker/src/celltext.ts', '同上']
]) {
  const src = readFileSync(join(root, rel), 'utf-8')
  ok(/副本|copy|Workers Builds|无法|不能/.test(src), `${rel} 顶部注释标注了「这是副本」（${why}）`)
}

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${'─'.repeat(60)}`)
if (failures === 0) {
  console.log('结果：全部通过 ✅  跨端副本仍然一致')
} else {
  console.log(`结果：${failures} 项失败 ❌  两份副本已经分叉，改一边必须改另一边`)
}
console.log('─'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
