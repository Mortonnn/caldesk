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
import { CalMark, Icon } from './icons'
import { DUR, EASE_EMPHASIZED, EASE_OUT, fade, riseIn } from './motion'
import { GlassDock } from './GlassDock'
import { MobileSetup } from './MobileSetup'
import './mobile.css'

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

/** 设备最后在线：今天只显示时分，跨天带日期，不再甩一整串本地化时间 */
function seenAt(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
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
  const [username, setUsername] = useState('')
  const [serverDraft, setServerDraft] = useState('')
  const [newCal, setNewCal] = useState('')
  const [calBusy, setCalBusy] = useState(false)
  const [confirmCal, setConfirmCal] = useState<string | null>(null)
  const [devices, setDevices] = useState<DeviceListResult['devices']>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 右上角日历切换菜单 */
  const [calMenu, setCalMenu] = useState(false)
  /** 月视图左右滑动手势 */
  const swipeRef = useRef<{ x: number; y: number; axis: 'x' | 'y' | null } | null>(null)
  /** 翻月方向：新月份从手指来的那一侧进场（1 = 往后翻，-1 = 往前翻） */
  const [dir, setDir] = useState(1)
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
      setUsername(st.username)
      setServerUrl(st.serverUrl || DEFAULT_SERVER_URL)
      setServerDraft(st.serverUrl || '')
      if (!st.paired) {
        setReady(true)
        return
      }
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

  /* 应用真正可用了再移除启动画面（移动端首帧由 index.html 内联绘制） */
  useEffect(() => {
    if (ready) window.__caldeskReady?.()
  }, [ready])

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
    // 服务端不保证顺序：先按日期排，同一天再按创建顺序，分组才是真实的时间线
    const sorted = [...events]
      .filter((x) => x.date >= today)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1
        return (a.event.createdAt ?? 0) - (b.event.createdAt ?? 0)
      })
      .slice(0, 60)
    const byDate = new Map<string, EventOccurrence[]>()
    for (const o of sorted) {
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
      setDir(dx < 0 ? 1 : -1)
      setDate((prev) => shiftMonth(prev, dx < 0 ? 1 : -1))
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  if (!ready) {
    return (
      <div className="m-shell m-boot">
        <span className="m-boot-tile">
          <CalMark size={44} />
        </span>
      </div>
    )
  }

  if (!paired) {
    return <MobileSetup onDone={() => { setPaired(true); void refreshAll() }} />
  }

  const cal = calendars.find((c) => c.id === calId)
  const today = todayISO()
  /** 顶栏标题跟着当前页走：月份 / 即将 / 设置，别让设置页顶着一个月份 */
  const title = tab === 'month' ? monthLabel(date) : tab === 'upcoming' ? '即将' : '设置'

  return (
    <div className="m-shell">
      {/* 顶栏：标题 + 日历切换。翻月靠左右滑，不占按钮 */}
      <header className="m-top">
        <div className="m-top-title">
          <span className="m-brand">
            <CalMark size={19} />
          </span>
          <motion.div
            className="m-top-month"
            key={title}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DUR.base, ease: EASE_OUT }}
          >
            {title}
          </motion.div>
        </div>
        {calendars.length > 0 && tab !== 'settings' && (
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

      {/* 日历切换：列表式弹出，选中项右侧打勾 */}
      <AnimatePresence>
        {calMenu && (
          <motion.div
            key="cal-mask"
            className="m-menu-mask"
            variants={fade}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: DUR.base, ease: EASE_OUT }}
            onClick={() => setCalMenu(false)}
          />
        )}
        {calMenu && (
          <motion.div
            key="cal-menu"
            className="m-menu"
            initial={{ opacity: 0, scale: 0.96, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: DUR.base, ease: EASE_EMPHASIZED }}
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
        )}
      </AnimatePresence>

      {/* 内容：切页只做一次很短的淡入 + 上浮，不做整屏横移 */}
      <div className="m-body">
        {loadError && (
          <button className="m-load-error" onClick={() => void loadRange(calId, date)}>
            {loadError} · 点这里重试
          </button>
        )}

        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.base, ease: EASE_OUT }}
        >
          {tab === 'month' && (
            <>
              {/* 月历网格：左右滑切换月份，新月份从手指来的那一侧滑进来 */}
              <motion.div
                className="m-grid"
                key={date.slice(0, 7)}
                initial={{ opacity: 0, x: dir * 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.26, ease: EASE_EMPHASIZED }}
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
                      aria-pressed={d === date}
                    >
                      <span className="m-grid-num">{Number(d.slice(8))}</span>
                      <span className="m-grid-dots">
                        {c?.tasks ? <i className="m-grid-dot m-grid-dot-task" /> : null}
                        {c?.events ? <i className="m-grid-dot m-grid-dot-event" /> : null}
                      </span>
                    </button>
                  )
                })}
              </motion.div>

              {/* 当天详情：日期标题 + 合并后的任务/事件列表 */}
              <motion.div
                className="m-day"
                key={date}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: DUR.base, ease: EASE_OUT }}
              >
                <div className="m-day-head">
                  <span className="m-day-title">{dayLabel(date)}</span>
                  {date !== today && (
                    <motion.button
                      className="m-today-btn"
                      whileTap={{ scale: 0.94 }}
                      onClick={() => setDate(today)}
                    >
                      今天
                    </motion.button>
                  )}
                </div>

                {/* 任务是"只属于这一天"，事件是"可以重复的任务"，本质是同一件事，
                    所以合成一张卡片，只用一个标签区分。 */}
                <div className="m-section">
                  <div className="m-section-head">
                    <span>这一天</span>
                  </div>
                  <div className="m-card">
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
                            <span className={`m-task-text ${it.occ.done ? 'm-task-done' : ''}`}>
                              {it.occ.event.title}
                            </span>
                            {eventKindLabel(it.occ.event) && (
                              <span className="m-task-tag">{eventKindLabel(it.occ.event)}</span>
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
              </motion.div>
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
                    <div className="m-card">
                      {list.map((o) => (
                        <button
                          className="m-group-item"
                          key={`${o.event.id}-${o.date}`}
                          onClick={() => setDate(d)}
                        >
                          <div
                            className="m-event-bar"
                            style={{ background: o.event.color ?? 'var(--m-accent)' }}
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
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="m-list">
              <div className="m-group">
                <div className="m-group-date">账号</div>
                <div className="m-card">
                  <div className="m-group-item">
                    <div className="m-group-main">
                      <div className="m-group-title">{username || '未登录'}</div>
                      <div className="m-group-sub">
                        {serverUrl.replace(/^https?:\/\//, '')}
                      </div>
                    </div>
                    <button
                      className="m-side-btn"
                      onClick={() => {
                        void (async () => {
                          await data.sync.logout()
                          setPaired(false)
                          setCalendars([])
                          setCells({})
                          setEvents([])
                          setDevices([])
                        })()
                      }}
                    >
                      退出登录
                    </button>
                  </div>
                </div>
              </div>

              <div className="m-group">
                <div className="m-group-date">服务器</div>
                <div className="m-card">
                  <div className="m-set-row">
                    <input
                      className="m-set-input"
                      value={serverDraft}
                      placeholder="https://你的-worker.workers.dev"
                      autoCapitalize="none"
                      autoCorrect="off"
                      inputMode="url"
                      onChange={(e) => setServerDraft(e.target.value)}
                    />
                    <button
                      className="m-side-btn"
                      onClick={() => {
                        void (async () => {
                          const res = await data.sync.setServer(serverDraft.trim(), '')
                          setServerUrl(res.serverUrl)
                          setServerDraft(res.serverUrl)
                          if (res.loggedOut) {
                            setPaired(false)
                            setCalendars([])
                            setCells({})
                            setEvents([])
                            return
                          }
                          say('已保存')
                        })()
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>
              </div>

              <div className="m-group">
                <div className="m-group-date">日历</div>
                <div className="m-card">
                  {calendars.map((c) => (
                    <div className="m-group-item" key={c.id}>
                      <div className="m-event-bar" style={{ background: c.color }} />
                      <div className="m-group-main">
                        <div className="m-group-title">{c.name}</div>
                      </div>
                      {confirmCal === c.id ? (
                        <div className="m-confirm-row">
                          <button className="m-side-btn" onClick={() => setConfirmCal(null)}>
                            取消
                          </button>
                          <button
                            className="m-side-btn danger"
                            onClick={() => {
                              void (async () => {
                                const res = await data.calendars.remove(c.id)
                                setConfirmCal(null)
                                if (!res.ok) {
                                  say(res.error)
                                  return
                                }
                                setCalendars(res.data)
                                if (calId === c.id) setCalId(res.data[0]?.id ?? '')
                                say('已删除')
                              })()
                            }}
                          >
                            删除
                          </button>
                        </div>
                      ) : (
                        <button
                          className="m-icon-mini"
                          aria-label={`删除日历 ${c.name}`}
                          disabled={calendars.length <= 1}
                          onClick={() => setConfirmCal(c.id)}
                        >
                          {Icon.trash}
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="m-set-row">
                    <input
                      className="m-set-input"
                      value={newCal}
                      placeholder="新日历名称"
                      onChange={(e) => setNewCal(e.target.value)}
                    />
                    <button
                      className="m-side-btn"
                      disabled={!newCal.trim() || calBusy}
                      onClick={() => {
                        void (async () => {
                          const name = newCal.trim()
                          if (!name) return
                          setCalBusy(true)
                          const res = await data.calendars.create(name)
                          setCalBusy(false)
                          if (!res.ok) {
                            say(res.error)
                            return
                          }
                          setCalendars(res.data.calendars)
                          setCalId(res.data.created.id)
                          setNewCal('')
                          say('已新建')
                        })()
                      }}
                    >
                      添加
                    </button>
                  </div>
                </div>
              </div>

              <div className="m-group">
                <div className="m-group-date">已登录设备</div>
                <div className="m-card">
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
                            {d.lastSeenAt ? ` · ${seenAt(d.lastSeenAt)}` : ''}
                          </div>
                        </div>
                        {!d.current && (
                          <button
                            className="m-side-btn"
                            onClick={() => {
                              void (async () => {
                                const res = await data.sync.revokeDevice(d.deviceId)
                                if (!res.ok) {
                                  say(res.error)
                                  return
                                }
                                setDevices((prev) => prev.filter((x) => x.deviceId !== d.deviceId))
                                say('已删除该设备')
                              })()
                            }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </motion.div>
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
          <motion.div
            key="sheet-mask"
            className="m-sheet-mask"
            variants={fade}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: DUR.base, ease: EASE_OUT }}
            onClick={() => setAdding(false)}
          />
        )}
        {adding && (
          <motion.div
            key="sheet"
            className="m-sheet"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: DUR.page, ease: EASE_EMPHASIZED }}
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
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            className="m-toast"
            variants={riseIn(6)}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: DUR.base, ease: EASE_OUT }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
