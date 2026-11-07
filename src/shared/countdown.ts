/**
 * 倒数日「还剩几天」的唯一实现（桌面端 / 手机端 / 主进程共用）。
 *
 * 语义必须两端一致，否则同一件事会算出两个数：
 *  - 只按「日历日」算：内部用 UTC 日序号相减，不含时刻、不受时区偏移影响；
 *  - 含头：目标日当天 = 0（显示「今天」），目标日次日 = 1；
 *  - 负数是「已过 N 天」。
 *
 * 之前 `src/main/db.ts` 有一个 `daysUntil`、`App.tsx` 里又内联了一份同样的减法，
 * 两处都没人管就会慢慢算出不同的结果。现在只留这里一份。
 */
import { toDayNumber } from './rrule'

/** 距离目标日还有几天（负数表示已过） */
export function countdownDays(targetDate: string, fromDate: string): number {
  return toDayNumber(targetDate) - toDayNumber(fromDate)
}

/**
 * 倒数日的展示文案：今天 / 还有 N 天 / 已过 N 天。
 * targetDate 为空（不是倒数日）返回 null，方便调用方直接条件渲染。
 */
export function countdownText(targetDate: string | null | undefined, fromDate: string): string | null {
  if (!targetDate) return null
  const days = countdownDays(targetDate, fromDate)
  if (days === 0) return '今天'
  return days > 0 ? `还有 ${days} 天` : `已过 ${-days} 天`
}
