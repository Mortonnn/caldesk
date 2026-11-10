import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  addDays,
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
  subMonths
} from 'date-fns'
import { zhCN } from 'date-fns/locale'
import {
  MINI_MAX_HEIGHT,
  MINI_MAX_WIDTH,
  MINI_MIN_HEIGHT,
  MINI_MIN_WIDTH,
  isMiniRange,
  isMiniView,
  type MiniRange,
  type MiniView
} from '@shared/mini'
import { isDoneLine, lineText, splitLines } from '@shared/types'
import { CalMark, Icon } from './icons'
import { data } from './data'
import './mini.css'

interface TaskItem {
  calendarId: string
  color: string
  calendarName: string
  /** 任务所在的日历日（多天范围里同一个行号会在不同日期重复出现） */
  date: string
  /** 在该视图日格中的行号，用于勾选 */
  index: number
  text: string
}

/** 某天的日程（事件 / 提醒 / 倒数日）——浮窗里只读展示，点一下回主窗口改 */
interface AgendaItem {
  calendarId: string
  color: string
  calendarName: string
  eventId: string
  date: string
  title: string
  kind: string
  done: boolean
}

/** 多天模式里的一天：事件在前、任务在后，和单天模式同一套行 */
interface DayGroup {
  date: string
  dateLabel: string
  weekday: string
  isToday: boolean
  events: AgendaItem[]
  tasks: TaskItem[]
}

/** 自然周（周一起）分组：week 与 week 之间要有比 day 更强的分隔 */
interface WeekGroup {
  key: string
  label: string
  days: DayGroup[]
}

/** 月视图的一格：整月网格里的一天，内容最多露两行 */
interface MonthCell {
  date: string
  day: number
  outside: boolean
  isToday: boolean
  events: AgendaItem[]
  tasks: TaskItem[]
}

const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 月视图表头固定周一起，和网格的 startOfWeek(weekStartsOn:1) 对齐 */
const WEEKDAY_MON = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function weekdayShort(date: Date): string {
  return WEEKDAY_SHORT[date.getDay()] ?? ''
}

/**
 * 'yyyy-MM-dd' → 本地零点。
 * 不能写 new Date(iso)：它按 UTC 解析，UTC 负偏移的时区会退到前一天，
 * 结果就是标题写着今天、分组却从昨天开始。
 */
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function Mini(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())
  const [pinned, setPinned] = useState(true)
  /** 显示范围以主进程设置真值为准；新安装默认 1月，设置回来前先按它画 */
  const [rangeMode, setRangeMode] = useState<MiniRange>('month')
  /** 显示样式：列表（原有日程流）/ 月视图（整月网格）。默认列表，行为和旧版一致 */
  const [viewMode, setViewMode] = useState<MiniView>('list')
  /** 月视图当前翻到的月份；始终停在当月 1 号，避免 1/31 翻月时被 date-fns 夹到 28 号 */
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()))
  const [items, setItems] = useState<TaskItem[]>([])
  const [agenda, setAgenda] = useState<AgendaItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const today = format(now, 'yyyy-MM-dd')
  const todayDate = useMemo(() => parseLocalDate(today), [today])

  /**
   * 范围终点：
   *  - day：今天
   *  - week：今天起 addDays(today, 7)，含两端共 8 天
   *  - month：今天起 addMonths(today, 1)，含两端
   * 全部在本地零点的 Date 上算，避免 parseISO/UTC 的时区坑。
   */
  const rangeEnd = useMemo(() => {
    if (rangeMode === 'week') return addDays(todayDate, 7)
    if (rangeMode === 'month') return addMonths(todayDate, 1)
    return todayDate
  }, [rangeMode, todayDate])
  const rangeTo = format(rangeEnd, 'yyyy-MM-dd')

  /**
   * 月视图的网格范围：整月 1 号到月末，再向外补满整周（周一起）。
   * 固定 35/42 格，数据也按这个范围一次读回来 —— 跨月露出的那几天照样能显示内容。
   */
  const monthStart = useMemo(() => startOfMonth(monthCursor), [monthCursor])
  const monthEnd = useMemo(() => endOfMonth(monthCursor), [monthCursor])
  const gridStart = useMemo(() => startOfWeek(monthStart, { weekStartsOn: 1 }), [monthStart])
  const gridEnd = useMemo(() => endOfWeek(monthEnd, { weekStartsOn: 1 }), [monthEnd])
  const gridFrom = format(gridStart, 'yyyy-MM-dd')
  const gridTo = format(gridEnd, 'yyyy-MM-dd')

  /** 列表模式沿用原来的 today..rangeTo；月视图读整个网格范围 */
  const loadFrom = viewMode === 'month' ? gridFrom : today
  const loadTo = viewMode === 'month' ? gridTo : rangeTo

  const load = useCallback(async (): Promise<void> => {
    const cals = await data.calendars.list()
    if (!cals.ok) {
      setError(cals.error)
      setLoading(false)
      return
    }
    // 每个日历各一次区间读：31 天也只是一轮 batch，不按天循环打 IPC
    const groups = await Promise.all(
      cals.data.map(async (cal) => {
        const [cellRes, evs] = await Promise.all([
          data.cells.range(cal.id, loadFrom, loadTo),
          data.events.range(cal.id, loadFrom, loadTo)
        ])
        const tasks: TaskItem[] = cellRes.ok
          ? cellRes.data.flatMap((cell) =>
              splitLines(cell.text)
                .map((line, index) => ({
                  calendarId: cal.id,
                  color: cal.color,
                  calendarName: cal.name,
                  date: cell.date,
                  index,
                  text: line
                }))
                .filter((t) => t.text.trim().length > 0)
            )
          : []
        const events: AgendaItem[] = evs.ok
          ? evs.data
              .filter((o) => o.date >= loadFrom && o.date <= loadTo)
              .map((o) => ({
                calendarId: cal.id,
                color: cal.color,
                calendarName: cal.name,
                eventId: o.event.id,
                date: o.date,
                title: o.event.title,
                kind: o.event.kind,
                done: o.done
              }))
          : []
        return { tasks, events }
      })
    )
    setItems(groups.flatMap((g) => g.tasks))
    // 日程按"未完成在前、再按创建顺序"排，倒计时/提醒都算日程
    setAgenda(groups.flatMap((g) => g.events).sort((a, b) => Number(a.done) - Number(b.done)))
    setError(null)
    setLoading(false)
  }, [loadFrom, loadTo])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      setNow(new Date())
      void load()
    }, 30_000)
    return () => clearInterval(timer)
  }, [load])

  // 主窗口改了数据（或自动同步拉下新数据）时立刻重读，浮窗不能显示旧内容
  useEffect(() => {
    return data.onDataChanged(() => {
      void load()
    })
  }, [load])

  /** 设置以主进程为准：置顶、显示范围/样式都可能在主窗口改完再广播过来 */
  const syncSettings = useCallback(() => {
    void data.settings.get().then(
      (s) => {
        setPinned(s.miniPinned)
        // 非法值保持当前值，别把设置面板的脏数据画进浮窗
        setRangeMode((prev) => (isMiniRange(s.miniRange) ? s.miniRange : prev))
        setViewMode((prev) => (isMiniView(s.miniView) ? s.miniView : prev))
      },
      (err: unknown) => setError((err as Error)?.message ?? '读取设置失败')
    )
  }, [])

  useEffect(() => {
    syncSettings()
  }, [syncSettings])

  // 设置面板切了 1天/1周/1月：范围进 state 后 load 的依赖变化，会立刻重读
  useEffect(() => {
    return data.onSettingsChanged(syncSettings)
  }, [syncSettings])

  async function toggle(item: TaskItem): Promise<void> {
    const done = isDoneLine(item.text)
    // 必须带这一行自己的日期：多天模式里同一个行号每天都有
    const res = await data.cells.setDone(item.calendarId, item.date, item.index, !done)
    if (!res.ok) {
      setError(res.error)
      return
    }
    const lines = splitLines(res.data.text)
    setItems((prev) =>
      prev.map((t) =>
        t.calendarId === item.calendarId && t.date === item.date && t.index === item.index
          ? { ...t, text: lines[item.index] ?? t.text }
          : t
      )
    )
  }

  /** 浮窗里直接勾选日程（重复事件按"这一次"记，单次事件记在事件本身） */
  async function toggleEvent(item: AgendaItem): Promise<void> {
    const res = await data.events.setDone(item.eventId, item.date, !item.done)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setAgenda((prev) =>
      prev.map((a) =>
        a.eventId === item.eventId && a.date === item.date ? { ...a, done: !a.done } : a
      )
    )
  }

  /* ------------------------------ 拖把手缩放 ------------------------------ */
  /**
   * transparent:true 的窗口在 Electron 里开不了原生 resizable（会破坏透明合成），
   * 所以右下角这颗把手得自己算：pointerdown 记起点和当前窗口尺寸，
   * pointermove 按屏幕位移算新尺寸，rAF 节流交给主进程 setSize。
   */
  const resize = useRef<{
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    frame: number
    pending: { width: number; height: number } | null
    last: { width: number; height: number }
  } | null>(null)

  const clampSize = useCallback((width: number, height: number) => {
    return {
      width: Math.min(MINI_MAX_WIDTH, Math.max(MINI_MIN_WIDTH, Math.round(width))),
      height: Math.min(MINI_MAX_HEIGHT, Math.max(MINI_MIN_HEIGHT, Math.round(height)))
    }
  }, [])

  function onGripDown(e: React.PointerEvent<HTMLSpanElement>): void {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resize.current = {
      startX: e.screenX,
      startY: e.screenY,
      startWidth: window.innerWidth,
      startHeight: window.innerHeight,
      frame: 0,
      pending: null,
      last: { width: window.innerWidth, height: window.innerHeight }
    }
  }

  function onGripMove(e: React.PointerEvent<HTMLSpanElement>): void {
    const r = resize.current
    if (!r) return
    const next = clampSize(
      r.startWidth + (e.screenX - r.startX),
      r.startHeight + (e.screenY - r.startY)
    )
    if (next.width === r.last.width && next.height === r.last.height) return
    r.pending = next
    if (r.frame) return
    r.frame = window.requestAnimationFrame(() => {
      r.frame = 0
      const pending = r.pending
      r.pending = null
      if (!pending) return
      r.last = pending
      void data.mini.setSize(pending.width, pending.height).catch((err: unknown) => {
        setError((err as Error)?.message ?? '调整浮窗大小失败')
      })
    })
  }

  function onGripUp(e: React.PointerEvent<HTMLSpanElement>): void {
    const r = resize.current
    if (!r) return
    if (r.frame) {
      window.cancelAnimationFrame(r.frame)
      r.frame = 0
    }
    // 收尾再严格按松手时的位置算一次，避免最后一帧被 rAF 吞掉
    const final = clampSize(
      r.startWidth + (e.screenX - r.startX),
      r.startHeight + (e.screenY - r.startY)
    )
    r.pending = null
    if (final.width !== r.last.width || final.height !== r.last.height) {
      void data.mini.setSize(final.width, final.height).catch((err: unknown) => {
        setError((err as Error)?.message ?? '调整浮窗大小失败')
      })
    }
    resize.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  /**
   * 多天模式按天分组。
   * 只从「今天 → 范围终点」铺满每一天（空白天也要留一个 day-head），
   * 内容从两个区间结果里按日期贴回去，不再一天一个 IPC。
   */
  const dayGroups = useMemo<DayGroup[]>(() => {
    if (rangeMode === 'day') return []
    return eachDayOfInterval({ start: todayDate, end: rangeEnd }).map((d) => {
      const date = format(d, 'yyyy-MM-dd')
      return {
        date,
        dateLabel: format(d, 'M月d日', { locale: zhCN }),
        weekday: weekdayShort(d),
        isToday: date === today,
        events: agenda.filter((a) => a.date === date),
        tasks: items.filter((t) => t.date === date)
      }
    })
  }, [rangeMode, todayDate, rangeEnd, today, agenda, items])

  /**
   * 按自然周（周一起）再包一层。
   * 全部用相对周名：本周、下周、下下周、下下下周……
   * 不显示具体日期区间，周标题才能像吸顶条一样一直挂在列表顶部。
   */
  const weekGroups = useMemo<WeekGroup[]>(() => {
    if (rangeMode === 'day') return []
    const thisWeekStart = startOfWeek(todayDate, { weekStartsOn: 1 })
    const out: WeekGroup[] = []
    for (const day of dayGroups) {
      const weekStart = startOfWeek(parseLocalDate(day.date), { weekStartsOn: 1 })
      const key = format(weekStart, 'yyyy-MM-dd')
      let group = out.find((g) => g.key === key)
      if (!group) {
        const weekOffset = Math.round(
          (weekStart.getTime() - thisWeekStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
        )
        const label = weekOffset <= 0 ? '本周' : `${'下'.repeat(weekOffset)}周`
        group = { key, label, days: [] }
        out.push(group)
      }
      group.days.push(day)
    }
    return out
  }, [rangeMode, dayGroups, todayDate])

  /** 月视图网格：整月 + 前后补满整周，固定 35/42 格 */
  const monthCells = useMemo<MonthCell[]>(() => {
    if (viewMode !== 'month') return []
    return eachDayOfInterval({ start: gridStart, end: gridEnd }).map((d) => {
      const date = format(d, 'yyyy-MM-dd')
      return {
        date,
        day: d.getDate(),
        outside: d.getMonth() !== monthStart.getMonth(),
        isToday: date === today,
        events: agenda.filter((a) => a.date === date),
        tasks: items.filter((t) => t.date === date)
      }
    })
  }, [viewMode, gridStart, gridEnd, monthStart, today, agenda, items])

  /** 月视图副标题的待办数药丸：只算当前显示月份，别把前后补格算进来 */
  const monthPending = useMemo(() => {
    const from = format(monthStart, 'yyyy-MM-dd')
    const to = format(monthEnd, 'yyyy-MM-dd')
    return (
      items.filter((t) => !isDoneLine(t.text) && t.date >= from && t.date <= to).length +
      agenda.filter((a) => !a.done && a.date >= from && a.date <= to).length
    )
  }, [items, agenda, monthStart, monthEnd])

  const pending =
    items.filter((t) => !isDoneLine(t.text)).length + agenda.filter((a) => !a.done).length
  const empty = items.length === 0 && agenda.length === 0

  function agendaRow(a: AgendaItem): React.JSX.Element {
    return (
      <div
        key={`ev-${a.eventId}-${a.date}`}
        className={`mini-task-row mini-agenda ${a.done ? 'done' : ''}`}
        data-date={a.date}
      >
        {a.kind === 'countdown' ? (
          <span className="mini-agenda-dot" style={{ background: a.color }} />
        ) : (
          <button
            className={`mini-check ${a.done ? 'checked' : ''}`}
            aria-label={a.done ? '标记为未完成' : '标记为完成'}
            onClick={() => void toggleEvent(a)}
          />
        )}
        <button
          className="mini-task-text"
          title={`${a.calendarName} · ${
            a.kind === 'countdown' ? '倒数日' : a.kind === 'reminder' ? '提醒' : '日程'
          }`}
          onClick={() => void data.app.openMain()}
        >
          {a.title}
        </button>
        <span className="mini-cal-dot" style={{ background: a.color }} title={a.calendarName} />
      </div>
    )
  }

  function taskRow(item: TaskItem): React.JSX.Element {
    const done = isDoneLine(item.text)
    return (
      <div
        key={`${item.calendarId}-${item.date}-${item.index}`}
        className={`mini-task-row ${done ? 'done' : ''}`}
        data-date={item.date}
      >
        <button
          className={`mini-check ${done ? 'checked' : ''}`}
          aria-label={done ? '标记为未完成' : '标记为完成'}
          onClick={() => void toggle(item)}
        />
        <button
          className="mini-task-text"
          title={lineText(item.text)}
          onClick={() => void data.app.openMain()}
        >
          {lineText(item.text)}
        </button>
        <span className="mini-cal-dot" style={{ background: item.color }} title={item.calendarName} />
      </div>
    )
  }

  return (
    <div className={`mini ${viewMode === 'month' ? 'mini-view-month' : `mini-range-${rangeMode}`}`}>
      <header className="mini-head" onDoubleClick={() => void data.app.openMain()}>
        <div className="mini-title">
          <strong>
            <span className="mini-mark">
              <CalMark size={14} />
            </span>
            {viewMode === 'month' ? (
              format(monthCursor, 'yyyy年M月', { locale: zhCN })
            ) : rangeMode === 'day' ? (
              format(now, 'M月d日', { locale: zhCN })
            ) : (
              <span className="mini-title-range">
                {format(todayDate, 'M月d日', { locale: zhCN })} –{' '}
                {format(rangeEnd, 'M月d日', { locale: zhCN })}
              </span>
            )}
          </strong>
          <span className="mini-sub">
            {viewMode === 'month'
              ? '月视图'
              : rangeMode === 'day'
                ? format(now, 'EEEE', { locale: zhCN })
                : rangeMode === 'week'
                  ? '接下来 8 天'
                  : '今天起 1 个月'}
            {viewMode === 'month' ? (
              <span className="mini-count">{monthPending} 项待办</span>
            ) : pending > 0 ? (
              <span className="mini-count">{pending} 项待办</span>
            ) : null}
          </span>
        </div>
        <div className="mini-actions">
          {/* drag 区域的鼠标事件会被 OS 吞掉，onDoubleClick 基本按不到 —— 主窗口入口必须是这颗按钮 */}
          <button
            className="mini-btn mini-btn-open"
            title="打开主窗口"
            aria-label="打开主窗口"
            onClick={() => void data.app.openMain()}
          >
            打开
          </button>
          <button
            className={`mini-btn ${pinned ? 'on' : ''}`}
            title={pinned ? '取消置顶' : '置顶'}
            onClick={() => {
              const next = !pinned
              setPinned(next)
              void data.mini.pin(next)
            }}
          >
            {Icon.pin}
          </button>
          <button className="mini-btn" title="隐藏" onClick={() => void data.mini.hide()}>
            {Icon.x}
          </button>
        </div>
      </header>

      {viewMode === 'month' ? (
        <>
          <div className="mini-month-nav">
            <button
              className="mini-btn mini-month-nav-btn"
              title="上一月"
              aria-label="上一月"
              onClick={() => setMonthCursor((d) => subMonths(d, 1))}
            >
              ‹
            </button>
            <button
              className="mini-btn mini-month-nav-today"
              title="回到本月"
              onClick={() => setMonthCursor(startOfMonth(new Date()))}
            >
              今天
            </button>
            <button
              className="mini-btn mini-month-nav-btn"
              title="下一月"
              aria-label="下一月"
              onClick={() => setMonthCursor((d) => addMonths(d, 1))}
            >
              ›
            </button>
          </div>
          {loading ? (
            <p className="mini-empty">加载中…</p>
          ) : error ? (
            <p className="mini-empty">{error}</p>
          ) : (
            <div className="mini-month">
              <div className="mini-month-weekdays">
                {WEEKDAY_MON.map((w) => (
                  <span className="mini-month-weekday" key={w}>
                    {w}
                  </span>
                ))}
              </div>
              <div className="mini-month-grid">
                {monthCells.map((cell) => {
                  const total = cell.events.length + cell.tasks.length
                  // 事件在前、任务在后，总共最多两行；剩下的都收进 +N
                  const shownEvents = cell.events.slice(0, 2)
                  const shownTasks = cell.tasks.slice(0, Math.max(0, 2 - shownEvents.length))
                  const more = total - shownEvents.length - shownTasks.length
                  return (
                    <button
                      type="button"
                      key={cell.date}
                      className={`mini-month-cell${cell.outside ? ' outside' : ''}${
                        cell.isToday ? ' today' : ''
                      }`}
                      data-date={cell.date}
                      title={cell.date}
                      onClick={() => void data.app.openMain()}
                    >
                      <span
                        className={`mini-month-daynum${cell.isToday ? ' mini-month-today' : ''}`}
                      >
                        {cell.day}
                      </span>
                      {total > 0 ? (
                        <span className="mini-month-items">
                          {shownEvents.map((a) => (
                            <span
                              className={`mini-month-line event${a.done ? ' done' : ''}`}
                              key={`ev-${a.eventId}-${a.date}`}
                            >
                              <span className="mini-month-dot" style={{ background: a.color }} />
                              <span className="mini-month-line-text">{a.title}</span>
                            </span>
                          ))}
                          {shownTasks.map((item) => (
                            <span
                              className={`mini-month-line task${
                                isDoneLine(item.text) ? ' done' : ''
                              }`}
                              key={`${item.calendarId}-${item.date}-${item.index}`}
                            >
                              <span
                                className="mini-month-dot"
                                style={{ background: item.color }}
                              />
                              <span className="mini-month-line-text">{lineText(item.text)}</span>
                            </span>
                          ))}
                          {more > 0 ? <span className="mini-month-more">+{more}</span> : null}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="mini-list">
          {loading ? (
            <p className="mini-empty">加载中…</p>
          ) : error ? (
            <p className="mini-empty">{error}</p>
          ) : empty ? (
            <p className="mini-empty">
              {rangeMode === 'day' ? '今天没有任务和日程' : '这段时间没有任务和日程'}
            </p>
          ) : rangeMode === 'day' ? (
            <>
              {agenda.map((a) => agendaRow(a))}
              {agenda.length > 0 && items.length > 0 && <div className="mini-sep" />}
              {items.map((item) => taskRow(item))}
            </>
          ) : (
            <div className="mini-days">
              {weekGroups.map((week) => (
                <section className="mini-week" key={week.key}>
                  <div className="mini-week-head">{week.label}</div>
                  {week.days.map((day) => {
                    const count = day.events.length + day.tasks.length
                    return (
                      <section className="mini-day" key={day.date} data-date={day.date}>
                        <div className={`mini-day-head${day.isToday ? ' today' : ''}`}>
                          <span className="mini-day-date">{day.dateLabel}</span>
                          <span className="mini-day-week">{day.weekday}</span>
                          {day.isToday ? <span className="mini-day-today">今天</span> : null}
                          {count > 0 ? (
                            <span className="mini-day-count">{count} 项</span>
                          ) : (
                            <span className="mini-day-none">无安排</span>
                          )}
                        </div>
                        {day.events.map((a) => agendaRow(a))}
                        {day.tasks.map((item) => taskRow(item))}
                      </section>
                    )
                  })}
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      <footer className="mini-foot">
        <button className="mini-open" onClick={() => void data.app.openMain()}>
          打开日历
        </button>
      </footer>

      {/* 透明窗口没有原生可缩放边框，这颗把手就是唯一的自由缩放入口 */}
      <span
        className="mini-resize-grip"
        aria-hidden="true"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      />
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Mini />
  </StrictMode>
)
