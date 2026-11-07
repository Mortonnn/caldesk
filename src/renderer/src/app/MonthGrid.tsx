/**
 * 月历纸：42 个格子 + 会跑的选中透镜。
 *
 * 两个容易踩的细节都在这一个文件里，改动前先读注释：
 *   1. `<AnimatePresence>` 上的 `key={activeCal ? 'ready' : 'boot'}` —— 首启幽灵月历纸
 *   2. `--cell-row-fit` 量在第一格上 —— 格子行数随窗口高度变
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, type Variants } from 'framer-motion'
import { format, isSameMonth, isToday } from 'date-fns'
import type { EventOccurrence } from '@shared/types'
import { isDoneLine, lineText, splitLines } from '@shared/types'
import { layoutCell } from './util'

export function MonthGrid(props: {
  activeCal: string | null
  /** 换页键：视图或月份变一次换一张；同月内增删任务不换，免得整片闪一下 */
  gridKey: string
  /** 换页方向（由事件处理函数显式写入，不在渲染期改 ref） */
  gridDir: number
  variants: Variants
  days: Date[]
  cursor: Date
  cells: Record<string, string>
  eventsByDate: Record<string, EventOccurrence[]>
  selected: string | null
  /** 当前视图的颜色：事件没有自己的颜色时用它 */
  accent: string | undefined
  onSelectDay: (key: string) => void
}): React.JSX.Element {
  const {
    activeCal,
    gridKey,
    gridDir,
    variants,
    days,
    cursor,
    cells,
    eventsByDate,
    selected,
    accent,
    onSelectDay
  } = props

  /*
   * 格子能装几行内容：格子高度随窗口变，写死行数会浪费大屏空间。
   * 量一次"基准行高"（由 CSS 变量控制，跟随字号缩放），再量内容区高度，
   * 相除得到行数；然后把行高微调成"内容区高度 / 行数"，
   * 这样塞满的格子上下都不会留缝，行距也不会出现半个像素的错位。
   * 只观测第一格——所有格子等高。
   */
  const [cellRows, setCellRows] = useState(3)
  const cellBodyProbe = useRef<HTMLDivElement | null>(null)
  const cellRowProbe = useRef<HTMLSpanElement | null>(null)
  /* 换页时整片月历会重挂载；量行高的变量写在不会重挂载的 stage 上 */
  const gridRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const body = cellBodyProbe.current
    const probe = cellRowProbe.current
    if (!body || !probe) return
    const measure = (): void => {
      const baseRow = probe.getBoundingClientRect().height
      const available = body.clientHeight
      if (baseRow <= 0 || available <= 0) return
      const rows = Math.max(1, Math.floor(available / baseRow))
      setCellRows((prev) => (prev === rows ? prev : rows))
      gridRef.current?.style.setProperty('--cell-row-fit', `${available / rows}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(body)
    return () => ro.disconnect()
  }, [gridKey])

  /*
   * 选中透镜的位置：第几列 / 第几行。
   * 交给 CSS 变量（@property 注册成 <number> 才能插值）驱动，
   * 这样不用在 JS 里量格子 —— 窗口缩放、换月重排之后位置都自动正确。
   */
  return (
    <div className="grid-stage" ref={gridRef}>
      {/*
        key 只在这里跳一次：拿到第一个视图之前 gridKey 是 `null|2026-11`，
        日历列表回来后会变成 `视图id|2026-11`。这一次 key 变化发生在首帧那一提交里，
        framer-motion 的退场回收会丢（旧纸停在 opacity:0 却一直留在 DOM 里），
        留下一整张看不见、但还能 Tab 进去的 42 格纸。
        用 key 把"还没视图"和"已有视图"分成两次挂载，旧纸整棵树直接丢掉，
        同时首帧本来就不该演换页（见上面 dir=0 的说明），这里正好对齐。
      */}
      <AnimatePresence initial={false} custom={gridDir} key={activeCal ? 'ready' : 'boot'}>
        <motion.div
          key={gridKey}
          className="grid"
          custom={gridDir}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          {days.map((day, dayIndex) => {
            const key = format(day, 'yyyy-MM-dd')
            const lines = splitLines(cells[key] ?? '')
            const dayEvents = eventsByDate[key] ?? []
            const outside = !isSameMonth(day, cursor)
            const fit = layoutCell(dayEvents.length, lines.length, cellRows)
            return (
              <button
                key={key}
                className={`cell ${outside ? 'outside' : ''} ${key === selected ? 'selected' : ''}`}
                onClick={() => onSelectDay(key)}
                aria-pressed={key === selected}
              >
                <span className={`daynum ${isToday(day) ? 'today' : ''}`}>{format(day, 'd')}</span>
                <div className="cell-body" ref={dayIndex === 0 ? cellBodyProbe : undefined}>
                  {dayIndex === 0 && (
                    <span className="cell-row-probe" ref={cellRowProbe} aria-hidden="true" />
                  )}
                  {fit.ev > 0 && (
                    <div className="cell-events">
                      {dayEvents.slice(0, fit.ev).map((occ) => (
                        <span key={`${occ.event.id}-${occ.date}`} className={`ev ${occ.done ? 'done' : ''}`}>
                          <i
                            className="ev-dot"
                            style={{ background: occ.event.color ?? accent ?? 'var(--accent)' }}
                          />
                          {occ.event.title}
                        </span>
                      ))}
                    </div>
                  )}
                  {fit.ln > 0 && (
                    <div className="cell-lines">
                      {lines.slice(0, fit.ln).map((line, i) => (
                        <span key={i} className={`line ${isDoneLine(line) ? 'done' : ''}`}>
                          {lineText(line)}
                        </span>
                      ))}
                    </div>
                  )}
                  {fit.hidden > 0 && <span className="cell-more">+{fit.hidden}</span>}
                </div>
              </button>
            )
          })}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
