/**
 * 同步内核测试。运行： node scripts/verify-sync.mjs
 */
import { compareRows, diffSince, mergeRemote, nextCursor } from '../src/shared/sync.ts'

let failures = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    failures += 1
    console.error(`  ✗ ${label}\n      期望 ${b}\n      实际 ${a}`)
  }
}

const row = (id, updatedAt, deletedAt = null) => ({ id, updatedAt, deletedAt })

console.log('\n[1] LWW 比较')
eq(compareRows(row('a', 100), row('a', 200)), 'remote', '远端更新 → remote 胜')
eq(compareRows(row('a', 300), row('a', 200)), 'local', '本地更新 → local 胜')
eq(compareRows(row('a', 200), row('a', 200), 'devA', 'devA'), 'equal', '同设备同时间 → 相等')
eq(
  compareRows(row('a', 200), row('a', 200), 'devA', 'devB'),
  'remote',
  '同时间戳 devB > devA → remote 胜'
)
eq(
  compareRows(row('a', 200), row('a', 200), 'devZ', 'devA'),
  'local',
  '同时间戳 devZ > devA → local 胜'
)

// 对称性：两端各自算，必须得出同一个赢家
const l = row('x', 500)
const r = row('x', 500)
const fromLocal = compareRows(l, r, 'devA', 'devB')
const fromRemote = compareRows(r, l, 'devB', 'devA')
eq(
  (fromLocal === 'remote') === (fromRemote === 'local'),
  true,
  '两端结论一致（A 认为是远端赢，B 就认为是本地赢）'
)

console.log('\n[2] 增量裁剪')
const rows = [row('a', 100), row('b', 200), row('c', 300)]
eq(diffSince(rows, 200).map((r) => r.id), ['c'], '严格大于水位，不重复推 b')
eq(diffSince(rows, 0).length, 3, '水位 0 时全量')

console.log('\n[3] 合并：新增 / 更新 / 保留')
const local = new Map([
  ['a', row('a', 100)],
  ['b', row('b', 300)]
])
const remote = [
  row('a', 200), // 远端更新 → 采用
  row('b', 250), // 本地更新 → 回推
  row('c', 150) // 本地没有 → 新增
]
const merged = mergeRemote(local, remote, 'devLocal', 'devRemote')
eq(merged.apply.map((r) => r.id).sort(), ['a', 'c'], '采用 a（远端新）和 c（新增）')
eq(merged.pushBack.map((r) => r.id), ['b'], 'b 本地更新，需回推')
eq(merged.unchanged, 0, '无相等项')

console.log('\n[4] 墓碑（删除）必须传播')
const local2 = new Map([['a', row('a', 100)]])
const tombstone = [row('a', 200, 1700000000000)]
const merged2 = mergeRemote(local2, tombstone, 'devLocal', 'devRemote')
eq(merged2.apply.length, 1, '墓碑被采用')
eq(merged2.apply[0].deletedAt !== null, true, '应用后是墓碑状态')

// 旧数据不能复活已删除的行
const local3 = new Map([['a', row('a', 300, 1700000000000)]])
const stale = [row('a', 200)]
const merged3 = mergeRemote(local3, stale, 'devLocal', 'devRemote')
eq(merged3.apply.length, 0, '旧的远端行不能覆盖墓碑')
eq(merged3.pushBack.length, 1, '墓碑需要回推给远端')

console.log('\n[5] 游标推进')
eq(nextCursor([row('a', 100), row('b', 500)], 0), 500, '取最大值')
eq(nextCursor([row('a', 100)], 500), 500, '不回退游标')
eq(nextCursor([], 42), 42, '空结果保持原游标')

console.log('\n' + '─'.repeat(52))
if (failures === 0) {
  console.log('结果：全部通过 ✅  同步合并规则正确')
  process.exit(0)
} else {
  console.error(`结果：${failures} 项失败 ❌`)
  process.exit(1)
}
