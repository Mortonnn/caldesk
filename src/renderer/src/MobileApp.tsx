/**
 * 手机端主应用。
 *
 * 与桌面端完全分开的一套界面：
 *  - 顶部：月份 + 日历切换
 *  - 中部：一周条 + 当天的任务 / 事件
 *  - 底部：视图切换 + 悬浮加号
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { CalendarEvent, CalendarMeta, DayCell, EventOccurrence } from '@shared/types'
import { isDoneLine, lineText, splitLines } from '@shared/types'
import { fromDayNumber, toDayNumber, weekdayOf } from '@shared/rrule'
import { data } from './data'
import { MobileSetup } from './MobileSetup'
import './mobile.css'

/* ------------------------------ 图标 ------------------------------ */

const Icon = {
  chevronLeft: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 11h18" /></svg>
  ),
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1A1.7 1.7 0 004.6 8a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
  )
}

/* ------------------------------ 工具 ------------------------------ */

const DOW = ['一', '二', '三', '四', '五', '六', '日']

function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 把 ISO 日期加 n 天 */
function addDays(iso: string, n: number): string {
  return fromDayNumber(toDayNumber(iso) + n)
}

function monthLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${DOW[(d.getDay() + 6) % 7]}`
}

/* ------------------------------ 主体 ------------------------------ */

type Tab = 'day' | 'upcoming' | 'settings'

export default function MobileApp(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [paired, setPaired] = useState(false)
  const [calendars, setCalendars] = useState<CalendarMeta[]>([])
  const [calId, setCalId] = useState<string>('')
  const [date, setDate] = useState(todayISO())
  const [cells, setCells] = useState<Record<string, DayCell>>({})
  const [events, setEvents] = useState<EventOccurrence[]>([])
  const [tab, setTab] = useState<Tab>('day')
  const [toast, setToast] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const say = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200)
  }, [])

  /* 启动：读身份 + 拉日历 */
  useEffect(() => {
    void (async () => {
      const st = await data.sync.getState()
      setPaired(st.paired)
      if (!st.paired) {
        setReady(true)
        return
      }
      const list = await data.calendars.list()
      if (list.ok) {
        setCalendars(list.data)
        setCalId(list.data[0]?.id ?? '')
      }
      setReady(true)
    })()
  }, [])

  /* 拉当周/当月的数据 */
  const loadRange = useCallback(
    async (cal: string, center: string) => {
      if (!cal) return
      const from = addDays(center, -7)
      const to = addDays(center, 45)
      const [c, e] = await Promise.all([
        data.cells.range(cal, from, to),
        data.events.range(cal, from, to)
      ])
      if (c.ok) {
        const map: Record<string, DayCell> = {}
        for (const cell of c.data) map[cell.date] = cell
        setCells(map)
      }
      if (e.ok) setEvents(e.data)
    },
    []
  )

  useEffect(() => {
    if (ready && paired && calId) void loadRange(calId, date)
  }, [ready, paired, calId, date, loadRange])

  /* 切前台时刷新一次 */
  useEffect(() => {
    const onFocus = (): void => {
      if (paired && calId) void loadRange(calId, date)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [paired, calId, date, loadRange])

  /* ------------------------------ 当天内容 ------------------------------ */

  const cell = cells[date]
  const lines = useMemo(() => splitLines(cell?.text ?? ''), [cell?.text])
  const dayEvents = useMemo(
    () => events.filter((o) => o.date === date),
    [events, date]
  )

  const weekDays = useMemo(() => {
    // 选中日期所在周（周一起）
    const n = toDayNumber(date)
    const back = weekdayOf(n)
    const start = n - back
    return Array.from({ length: 7 }, (_, i) => fromDayNumber(start + i))
  }, [date])

  const upcoming = useMemo(() => {
    const today = todayISO()
    const list = events
      .filter((o) => o.date >= today)
      .slice(0, 40)
    const byDate = new Map<string, EventOccurrence[]>()
    for (const o of list) {
      const arr = byDate.get(o.date) ?? []
      arr.push(o)
      byDate.set(o.date, arr)
    }
    return [...byDate.entries()]
  }, [events])

  /* ------------------------------ 操作 ------------------------------ */

  async function toggleTask(index: number): Promise<void> {
    if (!calId) return
    const line = lines[index]
    if (line === undefined) return
    const res = await data.cells.setDone(calId, date, index, !isDoneLine(line))
    if (res.ok) {
      const map = { ...cells, [date]: res.data }
      setCells(map)
    }
  }

  async function removeTask(index: number): Promise<void> {
    if (!calId) return
    const res = await data.cells.deleteLine(calId, date, index)
    if (res.ok) {
      setCells({ ...cells, [date]: res.data })
      say('已删除')
    }
  }

  async function addTask(): Promise<void> {
    const text = draft.trim()
    if (!text || !calId) return
    const res = await data.cells.appendLine(calId, date, text)
    if (res.ok) {
      setCells({ ...cells, [date]: res.data })
      setDraft('')
      setAdding(false)
      say('已添加')
    } else {
      say(res.error)
    }
  }

  async function refreshAll(): Promise<void> {
    const list = await data.calendars.list()
    if (list.ok) {
      setCalendars(list.data)
      if (!calId && list.data[0]) setCalId(list.data[0].id)
    }
    if (calId) await loadRange(calId, date)
  }

  /* ------------------------------ 渲染 ------------------------------ */

  if (!ready) {
    return (
      <div className="m-shell">
        <div className="m-body" />
      </div>
    )
  }

  if (!paired) {
    return <MobileSetup onDone={() => { setPaired(true); void refreshAll() }} />
  }

  const cal = calendars.find((c) => c.id === calId)

  return (
    <div className="m-shell">
      {/* 顶栏 */}
      <header className="m-top">
        <div className="m-top-title">
          <div className="m-top-month">
            {monthLabel(date)}
            <button
              className="m-icon-btn"
              onClick={() => setDate(addDays(date, -7))}
              aria-label="上一周"
            >
              {Icon.chevronLeft}
            </button>
            <button
              className="m-icon-btn"
              onClick={() => setDate(addDays(date, 7))}
              aria-label="下一周"
            >
              {Icon.chevronRight}
            </button>
          </div>
          <div className="m-top-sub">
            {cal ? cal.name : '未选择日历'} · 今天 {dayLabel(todayISO()).split(' ')[0]}
          </div>
        </div>
        {calendars.length > 1 && (
          <select
            className="m-chip"
            value={calId}
            onChange={(e) => setCalId(e.target.value)}
            style={{ border: 'none' }}
          >
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </header>

      {/* 内容 */}
      <div className="m-body">
        {tab === 'day' && (
          <>
            {/* 一周条 */}
            <div className="m-week">
              {weekDays.map((d) => {
                const hasTask = Boolean(cells[d] && splitLines(cells[d].text).some((l) => l.trim()))
                const hasEvent = events.some((o) => o.date === d)
                return (
                  <button
                    key={d}
                    className={[
                      'm-week-cell',
                      d === todayISO() ? 'm-week-today' : '',
                      d === date ? 'm-week-selected' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setDate(d)}
                  >
                    <span className="m-week-dow">
                      {DOW[weekdayOf(toDayNumber(d))]}
                    </span>
                    <span className="m-week-day">{Number(d.slice(8))}</span>
                    <span className="m-week-dots">
                      {hasTask && <i className="m-week-dot" />}
                      {hasEvent && <i className="m-week-dot" />}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* 当天详情 */}
            <div className="m-day">
              <div className="m-day-head">
                <span className="m-day-title">{dayLabel(date)}</span>
              </div>

              <div className="m-section">
                <div className="m-section-head">
                  <span>任务</span>
                  <button onClick={() => setAdding(true)}>添加</button>
                </div>
                {lines.length === 0 ? (
                  <div className="m-empty">这一天还没有任务</div>
                ) : (
                  lines.map((line, i) => {
                    const done = isDoneLine(line)
                    return (
                      <div className="m-task" key={`${i}-${line}`}>
                        <button
                          className={`m-task-check ${done ? 'm-task-check-on' : ''}`}
                          onClick={() => void toggleTask(i)}
                          aria-label={done ? '取消完成' : '完成'}
                        >
                          {done && Icon.check}
                        </button>
                        <span className={`m-task-text ${done ? 'm-task-done' : ''}`}>
                          {lineText(line)}
                        </span>
                        <button
                          className="m-task-del"
                          onClick={() => void removeTask(i)}
                          aria-label="删除"
                        >
                          {Icon.trash}
                        </button>
                      </div>
                    )
                  })
                )}
              </div>

              {dayEvents.length > 0 && (
                <div className="m-section">
                  <div className="m-section-head">
                    <span>事件 / 提醒</span>
                  </div>
                  {dayEvents.map((o) => (
                    <div className="m-event" key={`${o.event.id}-${o.date}`}>
                      <div
                        className="m-event-bar"
                        style={{
                          background: o.event.color ?? 'var(--m-accent)'
                        }}
                      />
                      <div className="m-event-main">
                        <div className="m-event-title">{o.event.title}</div>
                        <div className="m-event-meta">
                          {o.event.kind === 'reminder' && '提醒 · '}
                          {o.event.kind === 'countdown' && '倒数日 · '}
                          {o.event.rrule ? '重复' : '单次'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'upcoming' && (
          <div className="m-list">
            {upcoming.length === 0 ? (
              <div className="m-empty">没有即将到来的事件</div>
            ) : (
              upcoming.map(([d, list]) => (
                <div className="m-group" key={d}>
                  <div className="m-group-date">{dayLabel(d)}</div>
                  {list.map((o) => (
                    <div className="m-group-item" key={`${o.event.id}-${o.date}`}>
                      <div
                        className="m-event-bar"
                        style={{
                          background: o.event.color ?? 'var(--m-accent)',
                          height: 26
                        }}
                      />
                      <div className="m-group-main">
                        <div className="m-group-title">{o.event.title}</div>
                        <div className="m-group-sub">
                          {o.event.kind === 'reminder'
                            ? '提醒'
                            : o.event.kind === 'countdown'
                              ? '倒数日'
                              : '事件'}
                          {o.event.rrule ? ' · 重复' : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="m-list">
            <div className="m-group">
              <div className="m-group-date">同步</div>
              <div className="m-group-item">
                <div className="m-group-main">
                  <div className="m-group-title">服务器</div>
                  <div className="m-group-sub">caldesk.ilikeu.cc.cd</div>
                </div>
              </div>
              <div className="m-group-item">
                <div className="m-group-main">
                  <div className="m-group-title">这台设备</div>
                  <div className="m-group-sub">已加入账号，可在电脑端撤销</div>
                </div>
              </div>
            </div>
            <div className="m-group">
              <div className="m-group-date">日历</div>
              {calendars.map((c) => (
                <div className="m-group-item" key={c.id}>
                  <div
                    className="m-event-bar"
                    style={{ background: c.color, height: 26 }}
                  />
                  <div className="m-group-main">
                    <div className="m-group-title">{c.name}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部导航 */}
      <nav className="m-nav">
        <button
          className={`m-nav-item ${tab === 'day' ? 'm-nav-active' : ''}`}
          onClick={() => setTab('day')}
        >
          {Icon.calendar}
          日历
        </button>
        <button
          className={`m-nav-item ${tab === 'upcoming' ? 'm-nav-active' : ''}`}
          onClick={() => setTab('upcoming')}
        >
          {Icon.clock}
          即将
        </button>
        <div className="m-nav-fab">
          <button className="m-fab" onClick={() => setAdding(true)} aria-label="添加任务">
            {Icon.plus}
          </button>
        </div>
        <button
          className={`m-nav-item ${tab === 'settings' ? 'm-nav-active' : ''}`}
          onClick={() => setTab('settings')}
        >
          {Icon.settings}
          设置
        </button>
      </nav>

      {/* 添加任务弹层 */}
      <AnimatePresence>
        {adding && (
          <>
            <motion.div
              className="m-sheet-mask"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setAdding(false)}
            />
            <motion.div
              className="m-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            >
              <div className="m-sheet-handle" />
              <div className="m-sheet-title">添加到 {dayLabel(date).split(' ')[0]}</div>
              <input
                ref={inputRef}
                className="m-sheet-input"
                placeholder="要做什么？"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addTask()
                }}
              />
              <div className="m-sheet-actions">
                <button className="m-btn" onClick={() => setAdding(false)}>
                  取消
                </button>
                <button
                  className="m-btn m-btn-primary"
                  disabled={!draft.trim()}
                  onClick={() => void addTask()}
                >
                  添加
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {toast && (
        <motion.div
          className="m-toast"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
        >
          {toast}
        </motion.div>
      )}
    </div>
  )
}
