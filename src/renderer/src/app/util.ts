/**
 * 桌面端共享的常量与纯函数。
 *
 * 从原来的单文件 App.tsx 里原样搬出来：行为不变，只是让每个文件能独立读懂。
 */
import type { Variants } from 'framer-motion'
import { format } from 'date-fns'
import { DUR, EASE_EMPHASIZED, EASE_IN } from '../motion'

export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 历史默认露出几条，剩下的折叠 */
export const SNAP_PREVIEW = 5

export const TABLE_LABEL: Record<string, string> = {
  calendars: '日历',
  day_cells: '日格',
  events: '待办',
  event_done: '完成状态',
  event_skip: '跳过记录',
  notes: '便签'
}

/**
 * 换页：新旧两页沿同一根轴，速度不一样才像"一页推走一页"。
 *
 * 进的那页 14px、240ms（emphasized，起步快收尾慢）；出的是 8px、120ms（in，只出不进）。
 * 方向由 custom 传进来：往哪边翻，就从哪边进、往反方向退。
 * dir 为 0 表示这不是翻页（首次加载拿到视图），直接定格，不演。
 */
export const sheetSwap: Variants = {
  // 换页：单轴 X + 淡入，距离和手机端对齐（28px / 240ms，emphasized 曲线）
  initial: (dir: number) => (dir === 0 ? { opacity: 1, x: 0 } : { opacity: 0, x: 24 * dir }),
  animate: { opacity: 1, x: 0, transition: { duration: DUR.page, ease: EASE_EMPHASIZED } },
  exit: (dir: number) =>
    dir === 0
      ? { opacity: 0, transition: { duration: 0 } }
      : { opacity: 0, x: -12 * dir, transition: { duration: DUR.fast, ease: EASE_IN } }
}

/** 回滚记录的时间戳：当天只显示时分，跨天带上日期 */
export function stampOf(ts: number): string {
  const d = new Date(ts)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? `今天 ${format(d, 'HH:mm')}` : format(d, 'M月d日 HH:mm')
}

/**
 * 把 'yyyy-MM-dd' 解析为**本地**零点的 Date。
 * 不能用 new Date(iso)：那会按 UTC 解析，在 UTC 负偏移时区会退到前一天，
 * 导致详情面板显示的星期与网格里的格子对不上。
 */
export function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * 格子里一共留几行给内容：先放事件，再放任务行，放不下就用一行 "+N" 收尾。
 * 行数由格子的实际高度算出来，所以在 1080p 是 3 行、4K 下能到 6~8 行。
 */
export function layoutCell(
  evCount: number,
  lineCount: number,
  rows: number
): { ev: number; ln: number; hidden: number } {
  const total = evCount + lineCount
  if (total <= rows) return { ev: evCount, ln: lineCount, hidden: 0 }
  const budget = Math.max(1, rows - 1)
  const ev = Math.min(evCount, budget)
  const ln = Math.min(lineCount, budget - ev)
  return { ev, ln, hidden: total - ev - ln }
}

/**
 * 启动 / 打开面板时的一次性读取。
 *
 * 主进程的 handler 抛异常、通道没注册、preload 与主进程版本对不上时，
 * IPC 会变成 rejected Promise。以前这里只有 `.then(onOk)`，于是：
 * 屏幕上是"一个视图都没有、也没有任何提示"，控制台里躺着好几条未捕获的 Promise 拒绝。
 * 统一兜一层：失败也走 onFail（能显示就显示），绝不把异常漏到 window.onunhandledrejection。
 */
export function read<T>(p: Promise<T>, onOk: (v: T) => void, onFail?: (err: Error) => void): void {
  p.then(onOk, (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err))
    if (onFail) onFail(e)
    else console.error('[caldesk] 读取失败:', e.message)
  })
}
