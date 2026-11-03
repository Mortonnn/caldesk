/**
 * 手机端主应用。
 *
 * 与桌面端完全分开的一套界面：
 *  - 顶部：月份 + 日历切换
 *  - 中部：月历网格 → 点某天看当天详情
 *  - 底部：视图切换 + 悬浮加号
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { CalendarEvent, CalendarMeta, DayCell, EventOccurrence } from '@shared/types'
import { isDoneLine, lineText, splitLines } from '@shared/types'
import { describeRrule, fromDayNumber, toDayNumber, weekdayOf } from '@shared/rrule'
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
  chevronDown: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
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

/**
 * 按月翻页，**保留日号**（超出当月天数就落到月末）。
 *
 * 左右滑月份时如果每次跳回 1 号，滑两下就不知道自己在看哪天，
 * 所以这里保持 3 号滑过去还是 3 号。
 */
function shiftMonth(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00`)
  const target = new Date(d.getFullYear(), d.getMonth() + delta, 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  const day = Math.min(d.getDate(), lastDay)
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
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

/**
 * 列表右侧那个小标签。
 *
 * 任务和事件是同一件事，区别只有"只属于这一天"和"会重复"。
 * 默认不重复就不加标签（不然每行都是"当天"，纯噪音），
 * 只有真的会重复/是提醒/倒数日时才说明一句。
 */
function eventKindLabel(ev: CalendarEvent): string {
  if (ev.kind === 'countdown') return '倒数日'
  if (ev.rrule) return describeRrule(ev.rrule)
  return ev.kind === 'reminder' ? '提醒' : ''
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
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 右上角日历切换菜单 */
  const [calMenu, setCalMenu] = useState(false)
  /** 月视图左右滑动手势 */
  const swipeRef = useRef<{ x: number; y: number; axis: 'x' | 'y' | null } | null>(null)
  /**
   * 上次看到的服务端水位。
   *
   * 放 ref + localStorage 而不是 effect 里的局部变量：
   * effect 每次重跑都会把基线清零，导致"第一次只记录基准"的分支反复走，
   * 永远检测不到变更 —— 这正是"电脑改完手机必须退出重进"的根本原因。
   */
  const tokenRef = useRef(0)

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
      setServerUrl(st.serverUrl || DEFAULT_SERVER_URL)
      const list = await data.calendars.list()
      if (list.ok) {
        setCalendars(list.data)
        setCalId(list.data[0]?.id ?? '')
      }
      // 先把界面放出来再拉设备列表：设备列表慢一点不该让整个应用白屏
      setReady(true)
      void data.sync.devices().then((devs) => {
        if (devs.ok) setDevices(devs.data.devices)
      })
    })()
  }, [])

  /* 拉当月的数据 */
  const loadRange = useCallback(async (cal: string, center: string) => {
    if (!cal) return
    const from = addDays(center, -40)
    const to = addDays(center, 70)
    let lastErr = ''
    // 冷启动时第一条请求可能抢在网络上电前发出，失败重试一次再放弃
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [c, e] = await Promise.all([
        data.cells.range(cal, from, to),
        data.events.range(cal, from, to)
      ])
      if (c.ok) {
        const map: Record<string, DayCell> = {}
        for (const cell of c.data) map[cell.date] = cell
        setCells(map)
        setLoadError(null)
      } else {
        lastErr = c.error
      }
      if (e.ok) setEvents(e.data)
      if (c.ok || e.ok) return
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800))
    }
    // 两次都失败：明确告诉用户，别留一个看起来"没有任务"的空壳
    setLoadError(lastErr || '读不到数据')
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

  /* 打开设置页时重新拉一次设备列表，保证看到的是最新的已配对设备 */
  useEffect(() => {
    if (tab !== 'settings' || !paired) return
    void data.sync.devices().then((devs) => {
      if (devs.ok) setDevices(devs.data.devices)
    })
  }, [tab, paired])

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

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const probe = await data.sync.changes()
        if (stopped) return
        if (probe.remote > 0) {
          if (tokenRef.current === 0) {
            // 第一次只记基准，不触发刷新（避免刚打开就多拉一次）
            tokenRef.current = probe.remote
          } else if (probe.remote > tokenRef.current) {
            tokenRef.current = probe.remote
            await loadRange(calId, date)
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

  /** 从后台切回来（Android WebView 走 visibilitychange，不一定会发 focus） */
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && paired && calId) {
        void loadRange(calId, date)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [paired, calId, date, loadRange])

  /* ------------------------------ 当天内容 ------------------------------ */

  const cell = cells[date]
  const lines = useMemo(() => splitLines(cell?.text ?? ''), [cell?.text])
  const dayEvents = useMemo(() => events.filter((o) => o.date === date), [events, date])

  /**
   * 当天要显示的东西：任务和事件合成一个列表。
   *
   * 排序规则（用户指定）：
   *   1. 未完成在上，已完成在下；
   *   2. 组内按创建顺序，先创建的在前面。
   *
   * 事件有 createdAt，任务行本身没有时间戳，行号就是创建顺序，
   * 所以先按「事件（按 createdAt）→ 任务行（按行号）」拼出创建顺序，
   * 再用稳定排序把已完成的挪到后面 —— 稳定排序保证组内顺序不变。
   */
  const dayItems = useMemo(() => {
    const evs = [...dayEvents]
      .sort((a, b) => (a.event.createdAt ?? 0) - (b.event.createdAt ?? 0))
      .map((occ) => ({ type: 'event' as const, occ, done: occ.done }))
    const lns = lines
      .map((text, index) => ({ type: 'line' as const, text, index, done: isDoneLine(text) }))
      .filter((l) => l.text.trim().length > 0)
    return [...evs, ...lns].sort((a, b) => Number(a.done) - Number(b.done))
  }, [dayEvents, lines])

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

  async function removeEvent(o: EventOccurrence): Promise<void> {
    const res = await data.events.remove(o.event.id)
    if (res.ok) {
      setEvents(events.filter((x) => !(x.event.id === o.event.id && x.date === o.date)))
      say('已删除')
    } else {
      say('删除失败')
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

  /* ------------------------------ 手势 ------------------------------ */

  /**
   * 月视图左右滑切换月份。
   *
   * 只有"横向位移明显大于纵向、且超过阈值"才算翻月，
   * 免得上下滚动列表时误触发；手指按下再抬起没怎么动就是普通点选日期。
   */
  function onGridTouchStart(e: React.TouchEvent): void {
    const t = e.touches[0]
    swipeRef.current = { x: t.clientX, y: t.clientY, axis: null }
  }

  function onGridTouchMove(e: React.TouchEvent): void {
    const s = swipeRef.current
    if (!s) return
    const t = e.touches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (s.axis === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
  }

  function onGridTouchEnd(e: React.TouchEvent): void {
    const s = swipeRef.current
    swipeRef.current = null
    if (!s) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    // 不依赖 touchmove 里锁定的方向：合成手势的 move 可能被浏览器合并，
    // 直接看起止点的总位移最稳。
    if (s.axis === 'y') return
    if (Math.abs(dy) > Math.abs(dx)) return
    if (Math.abs(dx) > 56) {
      setDate((prev) => shiftMonth(prev, dx < 0 ? 1 : -1))
    }
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
      {/* 顶栏：只留月份 + 日历切换。翻月靠左右滑，不再放 ‹ › 按钮 */}
      <header className="m-top">
        <div className="m-top-title">
          <div className="m-top-month">{monthLabel(date)}</div>
        </div>
        {calendars.length > 0 && (
          <button
            className={`m-cal-btn ${calMenu ? 'on' : ''}`}
            onClick={() => setCalMenu((v) => !v)}
            aria-expanded={calMenu}
          >
            <span
              className="m-cal-dot"
              style={{ background: cal?.color ?? 'var(--m-accent)' }}
            />
            <span className="m-cal-name">{cal?.name ?? '日历'}</span>
            <span className="m-cal-chev">{Icon.chevronDown}</span>
          </button>
        )}
      </header>

      {/* 日历切换：仿 FlClash 的列表式弹出，选中项右侧打勾 */}
      <AnimatePresence>
        {calMenu && (
          <>
            <div className="m-menu-mask" onClick={() => setCalMenu(false)} />
            <motion.div
              className="m-menu"
              initial={{ opacity: 0, scale: 0.92, y: -10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: -8 }}
              transition={{ type: 'spring', stiffness: 460, damping: 34 }}
            >
              {calendars.map((c) => (
                <button
                  key={c.id}
                  className={`m-menu-item ${c.id === calId ? 'on' : ''}`}
                  onClick={() => {
                    setCalId(c.id)
                    setCalMenu(false)
                  }}
                >
                  <span className="m-menu-dot" style={{ background: c.color }} />
                  <span className="m-menu-label">{c.name}</span>
                  {c.id === calId && <span className="m-menu-check">{Icon.check}</span>}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* 内容 */}
      <div className="m-body">
        {loadError && (
          <button className="m-load-error" onClick={() => void loadRange(calId, date)}>
            {loadError} · 点这里重试
          </button>
        )}
        {tab === 'month' && (
          <>
            {/* 月历网格：左右滑切换月份 */}
            <div
              className="m-grid"
              onTouchStart={onGridTouchStart}
              onTouchMove={onGridTouchMove}
              onTouchEnd={onGridTouchEnd}
            >
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

            {/* 当天详情：日期标题 + 合并后的任务/事件列表 */}
            <div className="m-day">
              <div className="m-day-head">
                <span className="m-day-title">{dayLabel(date)}</span>
                {date !== today && (
                  <motion.button
                    className="m-today-btn"
                    whileTap={{ scale: 0.88 }}
                    onClick={() => setDate(today)}
                    aria-label="回到今天"
                  >
                    今
                  </motion.button>
                )}
              </div>

              {/* 任务是"只属于这一天"，事件是"可以重复的任务"，本质是同一件事，
                  所以合成一个列表，只用一个标签区分。 */}
              <div className="m-section">
                <div className="m-section-head">
                  <span>这一天</span>
                </div>
                {dayItems.length === 0 ? (
                  <div className="m-empty">这一天还没有安排</div>
                ) : (
                  dayItems.map((it) =>
                    it.type === 'event' ? (
                      <div className="m-task" key={`e-${it.occ.event.id}-${it.occ.date}`}>
                        <button
                          className={`m-task-check ${it.occ.done ? 'm-task-check-on' : ''}`}
                          onClick={() => void toggleEvent(it.occ)}
                          aria-label={it.occ.done ? '取消完成' : '完成'}
                        >
                          {it.occ.done && Icon.check}
                        </button>
                        <span
                          className={`m-task-text ${it.occ.done ? 'm-task-done' : ''}`}
                        >
                          {it.occ.event.title}
                        </span>
                        {eventKindLabel(it.occ.event) && (
                          <span className="m-task-tag">
                            {eventKindLabel(it.occ.event)}
                          </span>
                        )}
                        <button
                          className="m-task-del"
                          onClick={() => void removeEvent(it.occ)}
                          aria-label="删除"
                        >
                          {Icon.trash}
                        </button>
                      </div>
                    ) : (
                      <div className="m-task" key={`l-${it.index}-${it.text}`}>
                        <button
                          className={`m-task-check ${it.done ? 'm-task-check-on' : ''}`}
                          onClick={() => void toggleTask(it.index)}
                          aria-label={it.done ? '取消完成' : '完成'}
                        >
                          {it.done && Icon.check}
                        </button>
                        <span className={`m-task-text ${it.done ? 'm-task-done' : ''}`}>
                          {lineText(it.text)}
                        </span>
                        <button
                          className="m-task-del"
                          onClick={() => void removeTask(it.index)}
                          aria-label="删除"
                        >
                          {Icon.trash}
                        </button>
                      </div>
                    )
                  )
                )}
              </div>
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
                          {[eventTime(o.event), eventKindLabel(o.event)]
                            .filter(Boolean)
                            .join(' · ')}
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

      {/* 液态玻璃底栏：弹层打开时整条收起，别顶到键盘上面去 */}
      {!adding && (
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
      )}

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
