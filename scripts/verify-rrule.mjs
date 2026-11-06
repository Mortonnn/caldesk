/**
 * RRULE 展开器校验。
 * Node 24 原生支持 TS 类型擦除，可直接 import .ts。
 * 运行： node scripts/verify-rrule.mjs
 */
import {
  describeRrule,
  expandRrule,
  fromDayNumber,
  parseRrule,
  toDayNumber,
  weekdayOf
} from '../src/shared/rrule.ts'

let failures = 0
function fail(msg) {
  failures += 1
  console.error('  ✗', msg)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) fail(`${label}\n      期望 ${b}\n      实际 ${a}`)
}

/* ---------- 1. 星期基准 ---------- */
console.log('\n[1] 星期基准（1970-01-01 是周四）')
eq(weekdayOf(toDayNumber('1970-01-01')), 3, '1970-01-01 应为周四(3)')
eq(weekdayOf(toDayNumber('2026-11-02')), 0, '2026-11-02 应为周一(0)')
eq(weekdayOf(toDayNumber('2026-11-08')), 6, '2026-11-08 应为周日(6)')
eq(fromDayNumber(toDayNumber('2026-11-02')), '2026-11-02', '日号往返一致')

// 与 Date 交叉验证 200 天
let crossOk = true
for (let i = 0; i < 200; i += 1) {
  const n = toDayNumber('2025-01-01') + i
  const iso = fromDayNumber(n)
  const [y, m, d] = iso.split('-').map(Number)
  const expected = (new Date(y, m - 1, d).getDay() + 6) % 7
  if (weekdayOf(n) !== expected) {
    crossOk = false
    fail(`${iso} 星期不一致：rrule=${weekdayOf(n)} date=${expected}`)
  }
}
if (crossOk) console.log('  ✓ 200 天逐日与 Date 交叉验证一致')

/* ---------- 2. 每周三 ---------- */
console.log('\n[2] FREQ=WEEKLY;BYDAY=WE')
eq(
  expandRrule('FREQ=WEEKLY;BYDAY=WE', '2026-11-02', '2026-11-02', '2026-11-30'),
  ['2026-11-04', '2026-11-11', '2026-11-18', '2026-11-25'],
  '每周三（11 月共 4 次）'
)

/* ---------- 3. 每两天 ---------- */
console.log('\n[3] FREQ=DAILY;INTERVAL=2')
eq(
  expandRrule('FREQ=DAILY;INTERVAL=2', '2026-11-02', '2026-11-02', '2026-11-09'),
  ['2026-11-02', '2026-11-04', '2026-11-06', '2026-11-08'],
  '每两天'
)

/* ---------- 4. 每月 31 号：无 31 号的月份应跳过 ---------- */
console.log('\n[4] FREQ=MONTHLY;BYMONTHDAY=31')
eq(
  expandRrule('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31', '2026-01-01', '2026-12-31'),
  ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31'],
  '每月 31 号（2/4/6/9/11 月无 31 号）'
)

/* ---------- 5. COUNT 从首次开始日算起 ---------- */
console.log('\n[5] COUNT 语义')
eq(
  expandRrule('FREQ=WEEKLY;BYDAY=MO;COUNT=3', '2026-11-02', '2026-11-01', '2026-12-31'),
  ['2026-11-02', '2026-11-09', '2026-11-16'],
  'COUNT=3 只出 3 次'
)
eq(
  // 起始日在很久以前，COUNT 仍应从那时开始计数
  expandRrule('FREQ=WEEKLY;BYDAY=MO;COUNT=3', '2020-01-06', '2026-11-01', '2026-12-31'),
  [],
  'COUNT 已耗尽时区间内无结果'
)

/* ---------- 6. UNTIL ---------- */
console.log('\n[6] UNTIL 截止')
eq(
  expandRrule('FREQ=DAILY;UNTIL=20261105', '2026-11-02', '2026-11-01', '2026-11-30'),
  ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'],
  '紧凑格式 UNTIL 含当天'
)

/* ---------- 7. 每年 2 月 29 日：只在闰年出现 ---------- */
console.log('\n[7] FREQ=YEARLY（闰日）')
eq(
  expandRrule('FREQ=YEARLY', '2024-02-29', '2024-01-01', '2032-12-31'),
  ['2024-02-29', '2028-02-29', '2032-02-29'],
  '闰日每年重复只落在闰年'
)

/* ---------- 8. 区间裁剪 ---------- */
console.log('\n[8] 区间裁剪')
eq(
  expandRrule('FREQ=DAILY', '2026-01-01', '2026-11-02', '2026-11-04'),
  ['2026-11-02', '2026-11-03', '2026-11-04'],
  '只返回区间内的日期'
)

/* ---------- 9. 解析与描述 ---------- */
console.log('\n[9] 解析与文案')
const p = parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE')
eq(p.freq, 'WEEKLY', 'freq')
eq(p.interval, 2, 'interval')
eq(p.byday, [0, 2], 'byday 解析')
eq(describeRrule('FREQ=WEEKLY;BYDAY=WE'), '每周三', '文案：每周三')
eq(describeRrule('FREQ=WEEKLY;BYDAY=MO,WE'), '每周一、周三', '文案：每周一、周三')
eq(describeRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'), '每 2 周的周一、周三', '文案：每 2 周的周一、周三')
eq(describeRrule(null), '不重复', '文案：null')

console.log('\n' + '─'.repeat(52))
if (failures === 0) {
  console.log('结果：全部通过 ✅  RRULE 展开正确')
  process.exit(0)
} else {
  console.error(`结果：${failures} 项失败 ❌`)
  process.exit(1)
}
