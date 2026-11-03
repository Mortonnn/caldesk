/**
 * 日历网格正确性校验。
 *
 * 目标：确保「日期 ↔ 星期 ↔ 列」三者永远对齐，且不依赖渲染层的实现细节。
 * 做法：
 *   1. 用项目里同一套 date-fns 逻辑生成网格，检查列位与星期一致；
 *   2. 用**独立的**算法（蔡勒公式，不经过 Date 的星期计算）交叉验证；
 *   3. 跑 1970–2100 全部月份 + 已知参考日期 + 闰年边界。
 *
 * 运行： node scripts/verify-calendar.mjs
 */
import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  startOfMonth,
  startOfWeek
} from 'date-fns'

const WEEK_STARTS_ON = 1 // 周一为一周第一天

/** 蔡勒公式（Zeller），返回 0=周日 … 6=周六。独立于 JS Date 的 getDay 实现 */
function zellerWeekday(y, m, d) {
  let year = y
  let month = m
  if (month < 3) {
    month += 12
    year -= 1
  }
  const K = year % 100
  const J = Math.floor(year / 100)
  const h =
    (d +
      Math.floor((13 * (month + 1)) / 5) +
      K +
      Math.floor(K / 4) +
      Math.floor(J / 4) +
      5 * J) %
    7
  // h: 0=周六 1=周日 2=周一 … 6=周五
  return (h + 6) % 7
}

/** 周一起算的列索引：周一=0 … 周日=6 */
function mondayIndex(y, m, d) {
  const jsDay = zellerWeekday(y, m, d) // 0=周日
  return (jsDay + 6) % 7
}

function isoOf(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

let failures = 0
function fail(msg) {
  failures += 1
  if (failures <= 20) console.error('  ✗', msg)
}

/* ---------- 1. 参考日期（外部权威值） ---------- */
const references = [
  { date: '1970-01-01', weekday: '周四' },
  { date: '2000-01-01', weekday: '周六' },
  { date: '2024-02-29', weekday: '周四' },
  { date: '2026-11-02', weekday: '周一' },
  { date: '2026-12-25', weekday: '周五' },
  { date: '2033-01-01', weekday: '周六' }
]
const CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

console.log('\n[1] 参考日期校验')
for (const ref of references) {
  const [y, m, d] = ref.date.split('-').map(Number)
  const actual = CN[zellerWeekday(y, m, d)]
  if (actual !== ref.weekday) fail(`${ref.date} 期望 ${ref.weekday}，蔡勒公式得 ${actual}`)
  const viaJs = CN[new Date(y, m - 1, d).getDay()]
  if (viaJs !== ref.weekday) fail(`${ref.date} 期望 ${ref.weekday}，Date 得 ${viaJs}`)
}
if (failures === 0) console.log(`  ✓ ${references.length} 个参考日期全部匹配`)

/* ---------- 2. 逐月网格：列位必须等于星期 ---------- */
console.log('\n[2] 1970–2100 逐月网格列位校验')
let months = 0
let cells = 0
const before = failures

for (let year = 1970; year <= 2100; year += 1) {
  for (let month = 0; month < 12; month += 1) {
    const cursor = new Date(year, month, 1)
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: WEEK_STARTS_ON })
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: WEEK_STARTS_ON })
    const days = eachDayOfInterval({ start, end })
    months += 1

    if (days.length % 7 !== 0) {
      fail(`${year}-${month + 1} 网格长度 ${days.length} 不是 7 的倍数`)
    }
    const firstIdx = mondayIndex(
      days[0].getFullYear(),
      days[0].getMonth() + 1,
      days[0].getDate()
    )
    if (firstIdx !== 0) fail(`${year}-${month + 1} 首格是 ${CN[new Date(days[0]).getDay()]}，应为周一`)

    for (let i = 0; i < days.length; i += 1) {
      cells += 1
      const day = days[i]
      const col = i % 7
      const want = mondayIndex(day.getFullYear(), day.getMonth() + 1, day.getDate())
      if (col !== want) {
        fail(`${isoOf(day)} 落在第 ${col} 列，蔡勒公式算出应为第 ${want} 列`)
      }
      // 网格必须是连续日期
      if (i > 0) {
        const prev = days[i - 1]
        const diff = (day - prev) / 86400000
        // 跨夏令时可能不是整 24h，用日历天数比较
        const calDiff = Math.round(
          (Date.UTC(day.getFullYear(), day.getMonth(), day.getDate()) -
            Date.UTC(prev.getFullYear(), prev.getMonth(), prev.getDate())) /
            86400000
        )
        if (calDiff !== 1) fail(`${isoOf(prev)} 之后紧接 ${isoOf(day)}，间隔 ${diff} 天`)
      }
    }
  }
}

if (failures === before) {
  console.log(`  ✓ ${months} 个月 / ${cells} 个格子，列位与星期全部一致且日期连续`)
}

/* ---------- 3. 闰年与月末边界 ---------- */
console.log('\n[3] 闰年与月末边界')
const edge = [
  { date: new Date(2024, 1, 29), label: '2024-02-29 存在（闰年）' },
  { date: new Date(2100, 1, 28), label: '2100-02-28 存在（整百非闰）' }
]
for (const e of edge) {
  if (Number.isNaN(e.date.getTime())) fail(`${e.label} 解析失败`)
}
const feb2024 = endOfMonth(new Date(2024, 1, 1)).getDate()
if (feb2024 !== 29) fail(`2024 年 2 月应为 29 天，实际 ${feb2024}`)
const feb2100 = endOfMonth(new Date(2100, 1, 1)).getDate()
if (feb2100 !== 28) fail(`2100 年 2 月应为 28 天，实际 ${feb2100}`)
const feb2026 = endOfMonth(new Date(2026, 1, 1)).getDate()
if (feb2026 !== 28) fail(`2026 年 2 月应为 28 天，实际 ${feb2026}`)
console.log('  ✓ 闰年规则正确（2024=29 天，2100=28 天，2026=28 天）')

/* ---------- 4. 时区安全：ISO 字符串不得走 UTC 解析 ---------- */
console.log('\n[4] 时区安全校验')
function parseLocalDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const probe = '2026-11-02'
const local = parseLocalDate(probe)
if (local.getDate() !== 2 || local.getMonth() !== 10) {
  fail(`parseLocalDate('${probe}') 得到 ${local.toDateString()}`)
} else {
  console.log(`  ✓ parseLocalDate 保持本地日期不变（${local.toDateString()}）`)
}
const utcTrap = new Date(probe)
if (utcTrap.getTimezoneOffset() > 0 && utcTrap.getDate() !== 2) {
  console.log(`  ⚠ new Date('${probe}') 在本时区会退到 ${utcTrap.getDate()} 日——这正是要避免的写法`)
} else {
  console.log(`  · 本时区 UTC 偏移 ${-utcTrap.getTimezoneOffset() / 60}h，该陷阱暂不显现（换时区会）`)
}

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(52))
if (failures === 0) {
  console.log('结果：全部通过 ✅  日期与星期完全对齐')
  process.exit(0)
} else {
  console.error(`结果：${failures} 项失败 ❌`)
  process.exit(1)
}
