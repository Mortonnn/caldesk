/**
 * 手机端主应用。
 *
 * 与桌面端完全分开的一套界面：
 *  - 顶部：月份 + 日历切换
 *  - 中部：月历网格 → 点某天看当天详情
 *  - 底部：视图切换 + 悬浮加号
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { CalendarEvent, CalendarMeta, DayCell, EventOccurrence } from '@shared/types'
import { isDoneLine, lineText, splitLines } from '@shared/types'
import { fromDayNumber, toDayNumber, weekdayOf } from '@shared/rrule'
import { DEFAULT_SERVER_URL } from './mobileIdentity'
import { data } from './data'
import type { DeviceListResult } from './data'
import { GlassDock } from './GlassDock'
import { MobileSetup } from './MobileSetup'
import './mobile.css'

/* ------------------------------ 图标 ------------------------------ */

const Icon = {
  chevronLeft: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
  ),
  chevronRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
  ),
  calendar: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 11h18" /></svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1A1.7 1.7 0 004.6 8a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
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

/** 把 ISO 日期加 n 个月（保持 1 号） */
function addMonths(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`)
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`
}

function monthLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return `${d.getFullYear()}年${d.getMonth() + 1}月`
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${DOW[(d.getDay() + 6) % 7]}`
}

/** 事件的显示时间：全天只显示日期，有时分显示时分 */
function eventTime(ev: CalendarEvent): string {
  if (ev.allDay) return '全天'
  const s = ev.start
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return '全天'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function eventKindLabel(ev: CalendarEvent): string {
  if (ev.kind === 'reminder') return '提醒'
  if (ev.kind === 'countdown') return '倒数日'
  return ev.rrule ? '重复任务' : '任务'
}

/* ------------------------------ 主体 ------------------------------ */

type Tab = 'month' | 'upcoming' | 'settings'

export default function MobileApp(): React.JSX.Element {
  const [ready, setReady] = useState(false)
  const [paired, setPaired] = useState(false)
  const [calendars, setCalendars] = useState<CalendarMeta[]>([])
  const [calId, setCalId] = useState<string>('')
  const [date, setDate] = useState(todayISO())
  const [cells, setCells] = useState<Record<string, DayCell>>({})
  const [events, setEvents] = useState<EventOccurrence[]>([])
  const [tab, setTab] = useState<Tab>('month')
  const [toast, setToast] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
  const [devices, setDevices] = useState<DeviceListResult['devices']>([])

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
      setServerUrl(st.serverUrl || DEFAULT_SERVER_URL)
      // 设备列表：任何设备都能看到当前账号下配对的所有设备
      const devs = await data.sync.devices()
      if (devs.ok) setDevices(devs.data.devices)
      setReady(true)
    })()
  }, [])

  /* 拉当月的数据 */
  const loadRange = useCallback(async (cal: string, center: string) => {
    if (!cal) return
    const from = addDays(center, -40)
    const to = addDays(center, 70)
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
  }, [])

  useEffect(() => {
    if (ready && paired && calId) void loadRange(calId, date)
  }, [ready, paired, calId, date, loadRange])

  /* 切回前台时刷新一次 */
  useEffect(() => {
    const onFocus = (): void => {
      if (paired && calId) void loadRange(calId, date)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [paired, calId, date, loadRange])

  /**
   * 热更新：每隔几秒探一次服务端的水位。
   *
   * 电脑改完任务，手机不用退出重进就能看到。
   * 水位没变就什么都不做，不浪费流量。
   */
  useEffect(() => {
    if (!ready || !paired || !calId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let known = 0

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const probe = await data.sync.changes()
        if (!stopped && probe.remote > 0) {
          if (known === 0) {
            // 第一次探针只记录基准，不触发刷新
            known = probe.remote
          } else if (probe.remote > known) {
            known = probe.remote
            if (!stopped) await loadRange(calId, date)
          }
        }
      } catch {
        /* 网络不通就等下一轮 */
      }
      if (!stopped) timer = setTimeout(() => void tick(), 5000)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [ready, paired, calId, date, loadRange])

  /* ------------------------------ 当天内容 ------------------------------ */

  const cell = cells[date]
  const lines = useMemo(() => splitLines(cell?.text ?? ''), [cell?.text])
  const dayEvents = useMemo(() => events.filter((o) => o.date === date), [events, date])

  /** 当前月份的网格（6 行 × 7 列，周一起） */
  const monthGrid = useMemo(() => {
    const d = new Date(`${date}T00:00:00`)
    const first = new Date(d.getFullYear(), d.getMonth(), 1)
    const firstISO = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`
    const gridStart = toDayNumber(firstISO) - weekdayOf(toDayNumber(firstISO))
    return Array.from({ length: 42 }, (_, i) => fromDayNumber(gridStart + i))
  }, [date])

  /** 每天有几条任务 / 几个事件 */
  const dayCounts = useMemo(() => {
    const map: Record<string, { tasks: number; events: number }> = {}
    for (const [d, c] of Object.entries(cells)) {
      const n = splitLines(c.text).filter((l) => l.trim()).length
      if (n) map[d] = { ...map[d], tasks: n }
    }
    for (const o of events) {
      map[o.date] = { ...map[o.date], events: (map[o.date]?.events ?? 0) + 1 }
    }
    return map
  }, [cells, events])

  const upcoming = useMemo(() => {
    const today = todayISO()
    const byDate = new Map<string, EventOccurrence[]>()
    for (const o of events.filter((x) => x.date >= today).slice(0, 60)) {
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
    if (res.ok) setCells({ ...cells, [date]: res.data })
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

  async function toggleEvent(o: EventOccurrence): Promise<void> {
    const res = await data.events.setDone(o.event.id, o.date, !o.done)
    if (res.ok) {
      setEvents(
        events.map((x) =>
          x.event.id === o.event.id && x.date === o.date ? { ...x, done: !x.done } : x
        )
      )
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
  const today = todayISO()

  return (
    <div className="m-shell">
      {/* 顶栏 */}
      <header className="m-top">
        <div className="m-top-title">
          <div className="m-top-month">
            {monthLabel(date)}
            <div className="m-step">
              <button className="m-step-btn" onClick={() => setDate(addMonths(date, -1))} aria-label="上个月">
                {Icon.chevronLeft}
              </button>
              <button className="m-step-btn" onClick={() => setDate(addMonths(date, 1))} aria-label="下个月">
                {Icon.chevronRight}
              </button>
            </div>
          </div>
          <div className="m-top-sub">
            {cal ? cal.name : '未选择日历'} · 今天 {dayLabel(today).split(' ')[0]}
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
        {tab === 'month' && (
          <>
            {/* 月历网格 */}
            <div className="m-grid">
              {DOW.map((w) => (
                <div className="m-grid-dow" key={w}>
                  {w}
                </div>
              ))}
              {monthGrid.map((d) => {
                const inMonth = d.slice(0, 7) === date.slice(0, 7)
                const c = dayCounts[d]
                return (
                  <button
                    key={d}
                    className={[
                      'm-grid-cell',
                      inMonth ? '' : 'm-grid-out',
                      d === today ? 'm-grid-today' : '',
                      d === date ? 'm-grid-selected' : ''
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setDate(d)}
                  >
                    <span className="m-grid-num">{Number(d.slice(8))}</span>
                    <span className="m-grid-dots">
                      {c?.tasks ? <i className="m-grid-dot m-grid-dot-task" /> : null}
                      {c?.events ? <i className="m-grid-dot m-grid-dot-event" /> : null}
                    </span>
                  </button>
                )
              })}
            </div>

            {/* 当天详情 */}
            <div className="m-day">
              <div className="m-day-head">
                <span className="m-day-title">{dayLabel(date)}</span>
                {date !== today && (
                  <button className="m-day-today" onClick={() => setDate(today)}>
                    回到今天
                  </button>
                )}
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
                      <button
                        className={`m-task-check ${o.done ? 'm-task-check-on' : ''}`}
                        onClick={() => void toggleEvent(o)}
                        aria-label={o.done ? '取消完成' : '完成'}
                      >
                        {o.done && Icon.check}
                      </button>
                      <div className="m-event-main">
                        <div className={`m-event-title ${o.done ? 'm-task-done' : ''}`}>
                          {o.event.title}
                        </div>
                        <div className="m-event-meta">
                          {eventTime(o.event)} · {eventKindLabel(o.event)}
                        </div>
                      </div>
                      <div
                        className="m-event-bar"
                        style={{ background: o.event.color ?? 'var(--m-accent)' }}
                      />
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
                    <button className="m-group-item" key={`${o.event.id}-${o.date}`} onClick={() => setDate(d)}>
                      <div
                        className="m-event-bar"
                        style={{ background: o.event.color ?? 'var(--m-accent)', height: 26 }}
                      />
                      <div className="m-group-main">
                        <div className="m-group-title">{o.event.title}</div>
                        <div className="m-group-sub">
                          {eventTime(o.event)} · {eventKindLabel(o.event)}
                        </div>
                      </div>
                      {o.done && <span className="m-group-done">{Icon.check}</span>}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="m-list">
            <div className="m-group">
              <div className="m-group-date">已配对设备</div>
              {devices.length === 0 ? (
                <div className="m-empty">读不到设备列表</div>
              ) : (
                devices.map((d) => (
                  <div className="m-group-item" key={d.deviceId}>
                    <div className="m-group-main">
                      <div className="m-group-title">
                        {d.name || d.deviceId.slice(0, 8)}
                        {d.current ? '（本机）' : ''}
                      </div>
                      <div className="m-group-sub">
                        {d.status === 'approved' ? '已授权' : d.status}
                        {d.lastSeenAt ? ` · ${new Date(d.lastSeenAt).toLocaleString('zh-CN')}` : ''}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="m-group">
              <div className="m-group-date">日历</div>
              {calendars.map((c) => (
                <div className="m-group-item" key={c.id}>
                  <div className="m-event-bar" style={{ background: c.color, height: 26 }} />
                  <div className="m-group-main">
                    <div className="m-group-title">{c.name}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="m-group">
              <div className="m-group-date">服务器</div>
              <div className="m-group-item">
                <div className="m-group-main">
                  <div className="m-group-title">{serverUrl.replace(/^https?:\/\//, '')}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 液态玻璃底栏 */}
      <GlassDock
        items={[
          { key: 'month', label: '日历', icon: Icon.calendar },
          { key: 'upcoming', label: '即将', icon: Icon.clock },
          { key: 'settings', label: '设置', icon: Icon.settings }
        ]}
        active={tab}
        onSelect={(k) => setTab(k as Tab)}
        onAdd={() => setAdding(true)}
      />

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
