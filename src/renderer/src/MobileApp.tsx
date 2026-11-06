/**
 * 手机端主应用。
 *
 * 与桌面端完全分开的一套界面：
 *  - 顶部：月份 + 日历切换
 *  - 中部：月历网格 → 点某天看当天详情
 *  - 底部：视图切换 + 悬浮加号
 *
 * 启动：身份存在 localStorage 里，第一帧同步读出来就能画真界面，
 * 所以没有启动画面，也没有 ready 之前的那一段空白。
 *
 * 动效：全部走 CSS（transform / opacity），参数在 mobile.css 顶部。
 * 不用 JS 一帧一帧算，滑动和收尾交给 GPU，低端机才不抖。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { CalendarEvent, CalendarMeta, DayCell, EventKind, EventOccurrence } from '@shared/types'
import { isDoneLine, lineText, nextCalendarColor, splitLines } from '@shared/types'
import { describeRrule, fromDayNumber, toDayNumber, weekdayOf } from '@shared/rrule'
import { DEFAULT_SERVER_URL, isMobilePaired, loadMobileIdentity } from './mobileIdentity'
import {
  cellsFromText,
  clearCache,
  loadCache as loadMobileCache,
  saveCache as saveMobileCache,
  textFromCells
} from './mobileCache'
import { data } from './data'
import type { DeviceListResult } from './data'
import { CalMark, Icon } from './icons'
import { GlassDock } from './GlassDock'
import { MobileSetup } from './MobileSetup'
import { RepeatChip } from './RepeatChip'
import { SwipeRow } from './SwipeRow'
import './mobile.css'

/* ------------------------------ 工具 ------------------------------ */

const DOW = ['一', '二', '三', '四', '五', '六', '日']
/** 周几的 iCal 写法，和桌面端重复规则保持同一套 */
const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

/** 第一帧就要用的身份：同步读一次，之后由 reloadIdentity 维护 */
const bootIdentity = loadMobileIdentity()

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

/** 某个月的 42 格（6 行 × 7 列，周一起） */
function monthCells(monthISO: string): string[] {
  const d = new Date(`${monthISO}T00:00:00`)
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  const firstISO = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-01`
  const gridStart = toDayNumber(firstISO) - weekdayOf(toDayNumber(firstISO))
  return Array.from({ length: 42 }, (_, i) => fromDayNumber(gridStart + i))
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
 * 只标"会重复"：不重复的每行都一样，打标签纯噪音。
 * 提醒 / 倒数日已经取消，旧数据也按普通待办显示。
 */
function eventKindLabel(ev: CalendarEvent): string {
  return ev.rrule ? describeRrule(ev.rrule) : ''
}

/* ------------------------------ 主体 ------------------------------ */

type Tab = 'month' | 'upcoming' | 'settings'

/** 一次翻月的落点：0 = 留在本月，±1 = 换一个月 */
type Settle = -1 | 0 | 1

export default function MobileApp(): React.JSX.Element {
  /* 上一次看到的快照：先用它把界面画出来，再后台刷新（手机端以前要干等一轮网络） */
  const bootCache = useRef(loadMobileCache()).current
  const [paired, setPaired] = useState(() => isMobilePaired(bootIdentity))
  const [calendars, setCalendars] = useState<CalendarMeta[]>(bootCache.calendars)
  const [calId, setCalId] = useState<string>(bootCache.calId)
  const [date, setDate] = useState(todayISO())
  const [cells, setCells] = useState<Record<string, DayCell>>(() =>
    cellsFromText(bootCache.cellsByCal[bootCache.calId], bootCache.calId)
  )
  const [events, setEvents] = useState<EventOccurrence[]>(
    bootCache.eventsByCal[bootCache.calId] ?? []
  )
  const [tab, setTab] = useState<Tab>('month')
  const [toast, setToast] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  /** 新建待办时选的重复规则；默认不重复，加完回到不重复 */
  const [newRepeat, setNewRepeat] = useState<string | null>(null)
  /* 弹层两档：加一行待办，或者加一条正经日程（带时间/重复/类型） */
  const [addMode, setAddMode] = useState<'task' | 'event'>('task')
  const [evTitle, setEvTitle] = useState('')
  const [evTime, setEvTime] = useState('')
  const [evRepeat, setEvRepeat] = useState<'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'>('none')
  const [evKind, setEvKind] = useState<EventKind>('task')
  const [evBusy, setEvBusy] = useState(false)
  const [serverUrl, setServerUrl] = useState(bootIdentity?.serverUrl || DEFAULT_SERVER_URL)
  const [username, setUsername] = useState(bootIdentity?.username ?? '')
  const [serverDraft, setServerDraft] = useState(bootIdentity?.serverUrl || '')
  const [newCal, setNewCal] = useState('')
  const [calBusy, setCalBusy] = useState(false)
  const [confirmCal, setConfirmCal] = useState<string | null>(null)
  /**
   * 待确认的「删重复待办」。
   *
   * 重复待办点删除时不能直接删整条 —— 得问清楚是只删这一天，
   * 还是把这个重复整个删掉（跟电脑端一套问法）。
   */
  const [confirmEvent, setConfirmEvent] = useState<EventOccurrence | null>(null)
  const [devices, setDevices] = useState<DeviceListResult['devices']>([])
  /** 连不上服务器（轮询失败）。只用来提示，不阻断任何操作 */
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 右上角日历切换菜单 */
  const [calMenu, setCalMenu] = useState(false)
  /** 弹层里的输入框：弹层常驻 DOM，autoFocus 只在挂载时生效，所以开合自己管焦点 */
  const draftRef = useRef<HTMLInputElement | null>(null)
  /**
   * 切页动画方向。
   *
   * 首帧不给动画：内容已经在屏幕上了，再淡入一次等于把界面往后推 200ms，
   * 白屏时间白白变长。用户第一次切页才打开。
   */
  const [viewMotion, setViewMotion] = useState<'none' | 'next' | 'prev'>('none')

  /* 月历翻页用的三个 DOM 引用：视口、轨道、当前页码宽度 */
  const pagerRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ x: number; y: number; t: number; axis: 'x' | 'y' | null } | null>(null)
  /** 松手后正在收尾：这段时间内不再接受新手势，免得两段动画打架 */
  const settlingRef = useRef(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 上次看到的服务端水位。
   *
   * 放 ref + localStorage 而不是 effect 里的局部变量：
   * effect 每次重跑都会把基线清零，导致"第一次只记录基准"的分支反复走，
   * 永远检测不到变更 —— 这正是"电脑改完手机必须退出重进"的根本原因。
   */
  const tokenRef = useRef(0)

  /** 轮询循环里要调"当下那一版"的刷新函数，不能闭包在首帧上 */
  const refreshAllRef = useRef<() => Promise<boolean>>(async () => false)

  const say = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200)
  }, [])

  /**
   * 重新读一遍身份（账号、设备名、服务器地址）。
   * 登录后必须再读一次：登录会换设备凭据、也会写进用户名，
   * 不重读的话设置页会一直显示「未登录」。
   */
  const reloadIdentity = useCallback(async () => {
    const st = await data.sync.getState()
    setPaired(st.paired)
    setUsername(st.username)
    setServerUrl(st.serverUrl || DEFAULT_SERVER_URL)
    setServerDraft(st.serverUrl || '')
    return st
  }, [])

  /* 打开弹层就把键盘叫起来：等这一帧渲染完再 focus，WebView 才不会丢 */
  useEffect(() => {
    if (!adding) return
    const id = requestAnimationFrame(() => draftRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [adding])

  /**
   * 已经拉进内存的日期窗口。
   *
   * 以前点日历上任意一天都会重新拉一次数据，可这段数据本来就在内存里：
   * 一次点击白白多走三趟网络（两趟 range + 一趟被重启的轮询带的 /api/changes）。
   * 现在按「整月」为单位开窗：同一段里换日只是换视图，不发请求。
   *
   * 为什么按整月而不是按天：月历一次显示三个月（上／本月／下月），
   * 按天开窗的话窗口边界永远是斜的，点同月的另一天都会擦到边上去，等于没省。
   */
  const loadedRef = useRef<{ cal: string; from: string; to: string; at: number } | null>(null)
  /** 正在路上的那段请求：手势连甩时会连着喊两次一样的事，没必要发两趟 */
  const inflightRef = useRef<{ key: string; promise: Promise<boolean> } | null>(null)
  /** 窗口最多攒这么久（≈15 个月），翻到很远的月份时不至于越攒越大 */
  const MAX_SPAN_DAYS = 460
  /**
   * 刚拿回来多久以内的数据算"还热"。
   *
   * force 一般来自切回前台 / 轮询发现变更，这些是好事；
   * 但手势收尾和焦点事件有时会在同一下里连着触发两次，那就纯属重复请求了。
   */
  const FRESH_MS = 1500

  /**
   * 拉数据。返回值 = 这次有没有真的去服务端拿（false 表示用手上的内存就够）。
   * 轮询要靠这个决定能不能推进水位，不然"跳过一次"会被当成"已经是最新的"。
   */
  const loadRange = useCallback(async (cal: string, center: string, force = false): Promise<boolean> => {
    if (!cal) return false
    // 月历上看得见的是三个月，按整月开窗刚好盖住
    const needFrom = `${addMonths(center, -1).slice(0, 7)}-01`
    const needTo = addDays(`${addMonths(center, 2).slice(0, 7)}-01`, -1)
    const cur = loadedRef.current
    const sameCal = cur?.cal === cal
    /*
     * 要看的这几个月已经被窗口盖住了，直接用内存里的，不发请求。
     * force 是「服务端可能有变」的场合（切回前台、轮询发现变更、手动重试），这种要真去拿；
     * 但如果这段刚刚才拿回来（1.5 秒内），那就是同一下手势里的重复调用，跳过。
     */
    if (sameCal && needFrom >= cur!.from && needTo <= cur!.to) {
      if (!force || Date.now() - cur!.at < FRESH_MS) return false
    }
    let from = needFrom
    let to = needTo
    if (!force && sameCal) {
      // 往前后翻月：一次把并集拿回来，免得每翻一月补一次
      if (cur!.from < from) from = cur!.from
      if (cur!.to > to) to = cur!.to
      if (toDayNumber(to) - toDayNumber(from) > MAX_SPAN_DAYS) {
        from = needFrom
        to = needTo
      }
    }
    /*
     * force 只刷「眼前看得见的这几个月」：窗口攒到十几个月的时候，
     * 整段重拉在手机上就是几百 KB，没必要 —— 很久以前的月份等真翻回去再拉。
     */

    // 同一段已经在路上就别再发一遍（翻月的收尾和点格子有时会撞在同一段上）
    const key = `${cal}|${from}|${to}`
    const inflight = inflightRef.current
    if (inflight && inflight.key === key) return inflight.promise

    const run = (async (): Promise<boolean> => {
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
        if (c.ok || e.ok) {
          // 记住这次真正拿回来的窗口，下次同一段就不必再问服务端
          loadedRef.current = { cal, from, to, at: Date.now() }
          return true
        }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 800))
      }
      // 两次都失败：明确告诉用户，别留一个看起来"没有任务"的空壳
      setLoadError(lastErr || '读不到数据')
      return false
    })()

    inflightRef.current = { key, promise: run }
    try {
      return await run
    } finally {
      if (inflightRef.current?.key === key) inflightRef.current = null
    }
  }, [])

  /**
   * 缓存回写：状态一变就把当前快照存起来。
   * 下次冷启动直接画这一份，不必等网络；网络回来再覆盖成最新的。
   */
  useEffect(() => {
    if (!calId) return
    const prev = loadMobileCache()
    saveMobileCache({
      calendars,
      calId,
      cellsByCal: { ...prev.cellsByCal, [calId]: textFromCells(cells) },
      eventsByCal: { ...prev.eventsByCal, [calId]: events }
    })
  }, [calendars, calId, cells, events])

  /* 换日历时先把该日历的缓存顶上去，网络回来再覆盖（不然会短暂显示上一个日历的内容） */
  useEffect(() => {
    if (!calId) return
    const cached = loadMobileCache()
    setCells(cellsFromText(cached.cellsByCal[calId], calId))
    setEvents(cached.eventsByCal[calId] ?? [])
  }, [calId])

  /**
   * 挂载：界面已经在屏幕上了，这里只补数据。
   *
   * 只拉日历列表：当月数据由下面的 effect 自己拉（缓存里有 calId 时是并行的）。
   * 设备列表以前也跟着拉，但那玩意儿只有设置页看得见，
   * 冷启动白付一趟请求 —— 现在改成打开设置页再拉。
   */
  useEffect(() => {
    if (!paired) return
    void (async () => {
      const list = await data.calendars.list()
      if (list.ok) {
        setCalendars(list.data)
        setCalId((prev) => prev || list.data[0]?.id || '')
      }
    })()
    // 只在首次挂载跑一次；登录成功由 MobileSetup 的 onDone 负责刷新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (paired && calId) void loadRange(calId, date)
  }, [paired, calId, date, loadRange])

  /* 切回前台时刷新一次（force：这段时间别的设备可能改过，内存里的不作数） */
  useEffect(() => {
    const onFocus = (): void => {
      if (paired && calId) void loadRange(calId, date, true)
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
   *
   * 这个 effect 只在「登录状态」变的时候重建：以前依赖里有 date/calId/offline，
   * 点一下日历上别的日子就会把循环拆掉重来，顺手多发一趟 /api/changes。
   * 循环里要用的东西一律走 ref 取当下的值。
   */
  const offlineRef = useRef(false)
  useEffect(() => {
    refreshAllRef.current = refreshAll
    offlineRef.current = offline
  })

  useEffect(() => {
    if (!paired) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const probe = await data.sync.changes()
        if (stopped) return
        // 连不上服务器要能看见：以前失败和"没变更"都是 remote 0，界面毫无提示，
        // 用户只会觉得"软件坏了"（实际多半是没挂代理，直连被断）
        setOffline(probe.ok === false)
        if (probe.remote > 0) {
          if (tokenRef.current === 0) {
            // 第一次只记基准，不触发刷新（避免刚打开就多拉一次）
            tokenRef.current = probe.remote
          } else if (probe.remote > tokenRef.current) {
            /*
             * 别的设备可能新建了日历，所以整体重读，不只是当月日格。
             * 水位要等真的拿到新数据才推进：如果这次被"刚拉过"挡掉，
             * 水位照推就等于把这次变更永久咽掉了。
             */
            const refreshed = await refreshAllRef.current()
            if (refreshed) tokenRef.current = probe.remote
          }
        }
      } catch {
        if (!stopped) setOffline(true)
      }
      if (!stopped) timer = setTimeout(() => void tick(), offlineRef.current ? 3000 : 5000)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
    // 只跟着登录状态走：calId/date 变了不该重开一轮（那会白发一趟 /api/changes）
  }, [paired])

  /** 从后台切回来（Android WebView 走 visibilitychange，不一定会发 focus） */
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && paired && calId) {
        void loadRange(calId, date, true)
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
  /**
   * 当天要显示的东西：待办行 + 会重复的待办，合成一个列表。
   *
   * 排序（用户指定）：
   *   1. 没完成的在上，完成了的在下；
   *   2. 组内按创建顺序：先创建的在上面，后创建的在下面。
   *
   * 纯文本行没有时间戳，行号就是它的创建顺序；会重复的待办有 createdAt。
   * 两类没有共同的时间轴，所以顺序取「先文本行（按行号）、后重复待办（按 createdAt）」——
   * 这样在输入框里连续加的待办保持追加顺序，后加的重复待办也不会插到最上面。
   */
  const dayItems = useMemo(() => {
    const lns = lines.map((text, index) => ({ type: 'line' as const, text, index }))
    /*
     * 行的 React key 不能用数组下标：删掉一行以后后面所有下标都往前挪，
     * React 会把"正在滑出、opacity 0"的那一行复用给别的行，整天的待办就看不见了。
     * 用「去掉完成标记的文本 + 同名序号」做稳定身份：勾选完成时 key 不变，动画能接上；
     * 删掉别行也不影响这一行的身份。
     */
    const seen = new Map<string, number>()
    const mapped = lns
      .map((l) => {
        const base = lineText(l.text).trim()
        const n = (seen.get(base) ?? 0) + 1
        seen.set(base, n)
        return {
          type: 'line' as const,
          text: l.text,
          index: l.index,
          done: isDoneLine(l.text),
          rowKey: `l:${base}#${n}`
        }
      })
      .filter((l) => l.text.trim().length > 0)

    const evs = [...dayEvents]
      .sort((a, b) => (a.event.createdAt ?? 0) - (b.event.createdAt ?? 0))
      .map((occ) => ({ type: 'event' as const, occ, done: occ.done }))

    // 先文本行、后重复待办；再按完成与否稳定排序（稳定排序保住组内创建顺序）
    return [...mapped, ...evs].sort((a, b) => Number(a.done) - Number(b.done))
  }, [dayEvents, lines])

  /**
   * 可左右翻的三页：上个月 / 本月 / 下个月。
   *
   * 三页同时在 DOM 里，手指拖动只是移动整条轨道，
   * 翻完只换日期、不重建结构 —— 这就是 ViewPager 的手感来源。
   */
  const panes = useMemo(
    () => [addMonths(date, -1), addMonths(date, 0), addMonths(date, 1)],
    [date]
  )
  const paneGrids = useMemo(() => panes.map((p) => monthCells(p)), [panes])

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

  /**
   * 正在播完成动画的行（抄 MIUI 笔记）：
   * 点上以后先让行**留在原位**播 300ms 删除线 + 勾，播完才提交数据、才重排。
   * 以前直接提交，行瞬间跳到底部、key 又随文案变导致 DOM 重建，动画根本没机会播。
   */
  const [pendingDone, setPendingDone] = useState<{ index: number; done: boolean } | null>(null)
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current)
    },
    []
  )

  function toggleTask(index: number): void {
    const line = lines[index]
    if (line === undefined || !calId || pendingDone !== null) return
    const done = !isDoneLine(line)
    // 先亮状态（行不动），播完动画再写库
    setPendingDone({ index, done })
    if (pendingTimer.current) clearTimeout(pendingTimer.current)
    pendingTimer.current = setTimeout(() => {
      void data.cells.setDone(calId, date, index, done).then((res) => {
        // pending 的清除必须和 setCells 在同一帧：
        // 早一帧清就会露出"未完成"的旧态，安卓 HTTP 有延迟，会看成
        // 画线→变白→再画线。失败也要清（回滚）。
        setPendingDone(null)
        if (res.ok) setCells((prev) => ({ ...prev, [date]: res.data }))
      })
    }, 300)
  }

  /**
   * 加一条日程。
   *
   * 手机以前只能往当天塞一行文字，想加"周三下午三点的会"只能去电脑。
   * 这里补上最常用的三个字段：标题、时间（不填就是全天）、重复，类型默认任务。
   */
  function addEvent(): void {
    const title = evTitle.trim()
    if (!title || !calId || evBusy) return
    setEvBusy(true)
    const start = evTime ? `${date}T${evTime}:00` : date
    const rrule =
      evRepeat === 'daily'
        ? 'FREQ=DAILY'
        : evRepeat === 'weekly'
          ? `FREQ=WEEKLY;BYDAY=${BYDAY[weekdayOf(toDayNumber(date))]}`
          : evRepeat === 'monthly'
            ? 'FREQ=MONTHLY'
            : evRepeat === 'yearly'
              ? 'FREQ=YEARLY'
              : null
    void data.events
      .create({ calendarId: calId, kind: evKind, title, start, allDay: !evTime, rrule })
      .then((res) => {
        setEvBusy(false)
        if (!res.ok) {
          say(res.error)
          return
        }
        setEvTitle('')
        setEvTime('')
        setEvRepeat('none')
        setEvKind('task')
        setAdding(false)
        say('已添加日程')
        void loadRange(calId, date)
      })
  }

  /**
   * 改某一行待办的重复规则。
   *
   * 和电脑端同一套数据形态：不重复 = 日格里的一行文本；会重复 = events 表里
   * 一条 kind=task 的记录（只有它带 rrule、才会在别的日期出现）。
   */
  async function setRowRepeat(
    item:
      | { type: 'line'; index: number; text: string }
      | { type: 'event'; occ: EventOccurrence },
    rule: string | null
  ): Promise<void> {
    if (!calId) return
    const day = date
    /*
     * 一律先改本地再发请求：
     * 以前这里是 await 写库 → await 重拉，两趟往返，网络慢的时候点了没反应。
     * 失败就整块回滚（cells / events 都留了快照）。
     */
    const snapCells = cells
    const snapEvents = events

    if (item.type === 'event') {
      const ev = item.occ.event
      if (rule) {
        setEvents((prev) =>
          prev.map((x) => (x.event.id === ev.id ? { ...x, event: { ...x.event, rrule: rule } } : x))
        )
        say(describeRrule(rule))
        void data.events.update(ev.id, { rrule: rule }).then((res) => {
          if (!res.ok) {
            setEvents(snapEvents)
            say(res.error)
          }
        })
        return
      }
      // 改成不重复：本地把事件删掉、把标题接回当天文本
      const cur = cells[day]
      const nextText = cur?.text?.trim() ? `${cur.text.replace(/\s+$/, '')}\n${ev.title}` : ev.title
      setEvents((prev) => prev.filter((x) => x.event.id !== ev.id))
      setCells((prev) => ({
        ...prev,
        [day]: {
          ...(cur ?? {
            id: `${calId}:${day}`,
            calendarId: calId,
            date: day,
            color: null,
            updatedAt: 0,
            deletedAt: null
          }),
          text: nextText,
          updatedAt: Date.now()
        } as DayCell
      }))
      say('不重复了')
      void data.events.remove(ev.id).then(async (res) => {
        if (!res.ok) {
          setEvents(snapEvents)
          setCells(snapCells)
          say(res.error)
          return
        }
        const back = await data.cells.appendLine(calId, day, ev.title)
        if (!back.ok) {
          setEvents(snapEvents)
          setCells(snapCells)
          say(back.error)
        }
      })
      return
    }

    if (!rule) return
    const title = lineText(item.text)
    if (!title) return
    // 文本行 → 会重复的待办：本地先换形态
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const rest = splitLines(cells[day]?.text ?? '')
    rest.splice(item.index, 1)
    setCells((prev) => ({
      ...prev,
      [day]: { ...prev[day], text: rest.join('\n'), updatedAt: Date.now() } as DayCell
    }))
    setEvents((prev) => [
      ...prev,
      {
        date: day,
        done: false,
        event: {
          id: tempId,
          calendarId: calId,
          kind: 'task',
          title,
          notes: null,
          allDay: true,
          start: day,
          end: null,
          rrule: rule,
          remindMinutes: null,
          targetDate: null,
          color: null,
          completed: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          deletedAt: null
        }
      }
    ])
    say(describeRrule(rule))
    void data.events
      .create({ calendarId: calId, kind: 'task', title, start: day, allDay: true, rrule: rule })
      .then(async (created) => {
        if (!created.ok) {
          setCells(snapCells)
          setEvents(snapEvents)
          say(created.error)
          return
        }
        setEvents((prev) =>
          prev.map((x) => (x.event.id === tempId ? { ...x, event: created.data } : x))
        )
        const gone = await data.cells.deleteLine(calId, day, item.index)
        if (!gone.ok) {
          // 事件建好了但原文本行没删掉：以服务器为准重拉一次，别留两份
          setEvents(snapEvents)
          setCells(snapCells)
          say(gone.error)
        }
      })
  }

  /** 删任务行：立刻从界面拿掉，网络失败再放回来（手机上次"删除很慢"就是干等这一趟） */
  function removeTask(index: number): void {
    if (!calId) return
    const cur = cells[date]
    if (!cur) return
    const snapshot = cells
    const rest = splitLines(cur.text)
    rest.splice(index, 1)
    setCells({ ...cells, [date]: { ...cur, text: rest.join('\n') } })
    // 同一帧给反馈，不等回包
    say('已删除')
    void data.cells.deleteLine(calId, date, index).then((res) => {
      if (!res.ok) {
        setCells(snapshot)
        say(res.error)
        return
      }
      setCells((prev) => ({ ...prev, [date]: res.data }))
    })
  }

  /** 加一条待办：输入框和列表立刻响应，网络在后台跑，失败再回滚 */
  function addTask(): void {
    const text = draft.trim()
    if (!text || !calId) return
    // 输入框右边选了重复规则：建一条会重复的待办（events 表，带 rrule）
    if (newRepeat) {
      const rule = newRepeat
      setDraft('')
      setAdding(false)
      setNewRepeat(null)
      /*
       * 先在本地造一条临时记录画上去，再后台提交。
       * 以前是"等服务器返回 → 再整块重拉"，两趟往返，网络慢的时候能卡一秒多。
       */
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const temp: EventOccurrence = {
        date,
        done: false,
        event: {
          id: tempId,
          calendarId: calId,
          kind: 'task',
          title: text,
          notes: null,
          allDay: true,
          start: date,
          end: null,
          rrule: rule,
          remindMinutes: null,
          targetDate: null,
          color: null,
          completed: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          deletedAt: null
        }
      }
      setEvents((prev) => [...prev, temp])
      say('已添加')
      void data.events
        .create({
          calendarId: calId,
          kind: 'task',
          title: text,
          start: date,
          allDay: true,
          rrule: rule
        })
        .then((res) => {
          if (!res.ok) {
            // 失败：把临时行撤掉，内容放回输入框
            setEvents((prev) => prev.filter((x) => x.event.id !== tempId))
            setDraft(text)
            setAdding(true)
            setNewRepeat(rule)
            say(res.error)
            return
          }
          // 成功：用服务器的真实记录替换临时那条（拿到真 id，后续勾选/删除才对得上）
          setEvents((prev) =>
            prev.map((x) => (x.event.id === tempId ? { ...x, event: res.data } : x))
          )
        })
      return
    }
    const cur = cells[date]
    const snapshot = cells
    const base: DayCell =
      cur ?? {
        id: `${calId}:${date}`,
        calendarId: calId,
        date,
        text: '',
        color: null,
        updatedAt: Date.now(),
        deletedAt: null
      }
    const nextText = base.text.trim() ? `${base.text.replace(/\s+$/, '')}\n${text}` : text
    setCells({ ...cells, [date]: { ...base, text: nextText, updatedAt: Date.now() } })
    setDraft('')
    setAdding(false)
    // 提示立刻给，不等网络回包
    say('已添加')
    void data.cells.appendLine(calId, date, text).then((res) => {
      if (!res.ok) {
        setCells(snapshot)
        setDraft(text)
        setAdding(true)
        say(res.error)
        return
      }
      setCells((prev) => ({ ...prev, [date]: res.data }))
    })
  }

  async function toggleEvent(o: EventOccurrence): Promise<void> {
    // 乐观更新：行留在原位靠 CSS 播 300ms，不等网络
    setEvents(
      events.map((x) =>
        x.event.id === o.event.id && x.date === o.date ? { ...x, done: !x.done } : x
      )
    )
    await data.events.setDone(o.event.id, o.date, !o.done)
  }

  /**
   * 删重复待办：先问清楚删哪一部分。
   *
   * 以前手机上点删除直接把整个重复任务删了 —— 用户的其它日期也跟着没了。
   * 电脑端一直有「仅删除这天 / 删除整个重复」的区分，手机端得跟上一致。
   */
  function requestRemoveEvent(o: EventOccurrence): void {
    // 不是重复的（普通日程）直接删，不用问
    if (!o.event.rrule) {
      removeEvent(o)
      return
    }
    setConfirmEvent(o)
  }

  /** 仅删除这一天：往 event_skip 插一行，别的地方还留着 */
  async function skipOneOccurrence(target: EventOccurrence): Promise<void> {
    const snapshot = events
    setEvents(
      events.filter((x) => !(x.event.id === target.event.id && x.date === target.date))
    )
    setConfirmEvent(null)
    const res = await data.events.skip(target.event.id, target.date)
    if (!res.ok) {
      setEvents(snapshot)
      say(res.error)
      return
    }
    say('已删除这天')
  }

  /** 删除整个重复 */
  function removeEvent(o: EventOccurrence): void {
    const snapshot = events
    setEvents(events.filter((x) => !(x.event.id === o.event.id && x.date === o.date)))
    void data.events.remove(o.event.id).then((res) => {
      if (!res.ok) {
        setEvents(snapshot)
        say('删除失败')
        return
      }
      say('已删除')
    })
  }

  /**
   * 整体刷新：日历列表 + 当月内容。
   *
   * 只拉日格是不够的：别的设备新建（或删掉）的日历只有重读 calendars 才看得见，
   * 不重读就会出现"电脑上加了日历，手机里怎么都没有"。
   */
  async function refreshAll(): Promise<boolean> {
    const list = await data.calendars.list()
    if (list.ok) {
      setCalendars(list.data)
      const stillThere = list.data.some((c) => c.id === calId)
      const next = stillThere ? calId : (list.data[0]?.id ?? '')
      if (next !== calId) setCalId(next)
    }
    const target = calId
    // force：这是"服务端变了"才走的路径，内存里的窗口已经不可信
    if (target) return loadRange(target, date, true)
    return false
  }

  /* ------------------------------ 翻月手势 ------------------------------ */

  /**
   * 收尾：把轨道挪到目标页，动画结束后换日期并把轨道瞬时复位。
   *
   * 三页的静止位置是 translateX(-100%)（中间那页）。往左收尾就是 -200%，
   * 往右是 0%。落定那一帧同时做两件事：换日期（三页整体左移一页 + 复位到 -100%），
   * 两者位移刚好抵消，所以看不到跳。
   */
  const settle = useCallback((dir: Settle) => {
    const track = trackRef.current
    if (!track) return
    const REST = 'translate3d(-100%,0,0)'

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      if (dir !== 0) setDate((prev) => shiftMonth(prev, dir))
      track.style.transition = 'none'
      track.style.transform = ''
      return
    }

    settlingRef.current = true
    const done = (): void => {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
      track.removeEventListener('transitionend', done)
      if (dir !== 0) {
        flushSync(() => setDate((prev) => shiftMonth(prev, dir)))
        track.style.transition = 'none'
        track.style.transform = REST
        void track.offsetHeight // 读一次布局，让复位和换页落在同一帧
        track.style.transition = ''
        track.style.transitionDuration = ''
        track.style.transform = ''
      }
      settlingRef.current = false
    }

    // 用回 CSS 里那条曲线（拖动时它被关掉了）；没翻页的回弹要更快，别拖着
    track.style.transition = ''
    track.style.transitionDuration = dir === 0 ? '180ms' : ''
    track.style.transform =
      dir > 0 ? 'translate3d(-200%,0,0)' : dir < 0 ? 'translate3d(0%,0,0)' : REST
    track.addEventListener('transitionend', done, { once: true })
    // 兜底：transitionend 被系统动画打断时也得复位。
    // 翻页那条是 412ms 的 travel 弹簧，兜底要留在它之后，不然会抢在动画结束前换页。
    settleTimer.current = setTimeout(done, dir === 0 ? 260 : 620)
  }, [])

  function onGridTouchStart(e: React.TouchEvent<HTMLDivElement>): void {
    if (settlingRef.current) return
    const t = e.touches[0]
    dragRef.current = { x: t.clientX, y: t.clientY, t: performance.now(), axis: null }
    const track = trackRef.current
    if (track) {
      track.style.transition = 'none'
      track.style.transitionDuration = ''
    }
  }

  function onGridTouchMove(e: React.TouchEvent<HTMLDivElement>): void {
    const s = dragRef.current
    const track = trackRef.current
    const pager = pagerRef.current
    if (!s || !track || !pager) return
    const t = e.touches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (s.axis === null) {
      // 6px 就锁方向：横滑稍微一动就该跟手，别让手指先"憋"一段才动
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      s.axis = Math.abs(dx) >= Math.abs(dy) * 0.8 ? 'x' : 'y'
    }
    if (s.axis !== 'x') return
    const width = pager.clientWidth || 1
    // 拖到头就不再跟手，只留一点点阻尼
    const clamped =
      dx > width ? width + (dx - width) * 0.12 : dx < -width ? -width + (dx + width) * 0.12 : dx
    track.style.transform = `translate3d(calc(-100% + ${clamped}px),0,0)`
  }

  function onGridTouchEnd(e: React.TouchEvent<HTMLDivElement>): void {
    const s = dragRef.current
    dragRef.current = null
    if (!s || s.axis !== 'x') return
    const pager = pagerRef.current
    const width = pager?.clientWidth || 1
    const dx = e.changedTouches[0].clientX - s.x
    const dt = Math.max(1, performance.now() - s.t)
    const vx = dx / dt // px/ms
    // 三条都算翻页：拖过 18% 屏宽、或者一次明显的短甩（快 + 够 6% 距离）。
    // 之前要拖满 30% 才认，手指轻轻一拨完全没反应，就是"太不敏感"。
    const farEnough = Math.abs(dx) > width * 0.18
    const flicked = Math.abs(vx) > 0.35 && Math.abs(dx) > width * 0.06
    const hit = farEnough || flicked
    const dir: Settle = hit ? (dx < 0 ? 1 : -1) : 0
    settle(dir)
  }

  function onGridTouchCancel(): void {
    if (dragRef.current?.axis === 'x') settle(0)
    dragRef.current = null
  }

  /* ------------------------------ 渲染 ------------------------------ */

  if (!paired) {
    return (
      <MobileSetup
        onDone={() => {
          // 登录会写用户名 + 可能换设备凭据，必须重读身份再拉数据
          void (async () => {
            await reloadIdentity()
            await refreshAll()
            const devs = await data.sync.devices()
            if (devs.ok) setDevices(devs.data.devices)
          })()
        }}
      />
    )
  }

  const cal = calendars.find((c) => c.id === calId)
  const today = todayISO()
  /** 顶栏标题跟着当前页走：月份 / 即将 / 设置，别让设置页顶着一个月份 */
  const title = tab === 'month' ? monthLabel(date) : tab === 'upcoming' ? '即将' : '设置'

  return (
    <div className={`m-shell ${adding || confirmEvent ? 'is-blurred' : ''}`}>
      {/* 顶栏：标题 + 日历切换。翻月靠左右滑，不占按钮 */}
      <header className="m-top">
        <div className="m-top-title">
          <span className="m-brand">
            <CalMark size={19} />
          </span>
          <div className="m-top-month" key={title}>
            {title}
          </div>
        </div>
        {calendars.length > 0 && tab !== 'settings' && (
          <button
            className={`m-cal-btn ${calMenu ? 'on' : ''}`}
            onClick={() => setCalMenu((v) => !v)}
            aria-expanded={calMenu}
          >
            <span className="m-cal-dot" style={{ background: cal?.color ?? 'var(--m-accent)' }} />
            <span className="m-cal-name">{cal?.name ?? '日历'}</span>
            <span className="m-cal-chev">{Icon.chevronDown}</span>
          </button>
        )}
      </header>

      {/*
        连不上服务器时的常驻提示。
        以前轮询失败是完全静默的，用户只会觉得"软件坏了"；这里把状态摆出来，
        点一下立刻重试，恢复后自动消失。
      */}
      {offline && (
        <button className="m-offline" onClick={() => void refreshAll()}>
          <span className="m-offline-dot" />
          连不上服务器 · 点这里重试
        </button>
      )}

      {/* 日历切换：列表式弹出，选中项右侧打勾。常驻 DOM，开合只改 class */}
      <div
        className={`m-menu-mask ${calMenu ? 'is-open' : ''}`}
        onClick={() => setCalMenu(false)}
        aria-hidden={!calMenu}
      />
      <div
        className={`m-menu ${calMenu ? 'is-open' : ''}`}
        role="menu"
        aria-hidden={!calMenu}
      >
        {calendars.map((c) => (
          <button
            key={c.id}
            className={`m-menu-item ${c.id === calId ? 'on' : ''}`}
            role="menuitemradio"
            aria-checked={c.id === calId}
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
      </div>

      {/* 内容：切页只做一次很短的淡入 + 上浮，不做整屏横移 */}
      <div className="m-body">
        {loadError && (
          <button className="m-load-error" onClick={() => void loadRange(calId, date, true)}>
            {loadError} · 点这里重试
          </button>
        )}

        <div
          className={`m-view ${
            viewMotion === 'none' ? 'no-anim' : viewMotion === 'next' ? 'is-next' : 'is-prev'
          }`}
          key={tab}
        >
          {tab === 'month' && (
            <>
              {/*
                月历：三页并排，手指带走的是整条轨道。
                松手后轨道滑到目标页，落定再换日期并瞬时复位 —— 跟系统 ViewPager 一个套路。
              */}
              <div className="m-dow-row">
                {DOW.map((w) => (
                  <div className="m-grid-dow" key={w}>
                    {w}
                  </div>
                ))}
              </div>
              <div
                className="m-pager"
                ref={pagerRef}
                onTouchStart={onGridTouchStart}
                onTouchMove={onGridTouchMove}
                onTouchEnd={onGridTouchEnd}
                onTouchCancel={onGridTouchCancel}
              >
                <div className="m-track" ref={trackRef}>
                  {paneGrids.map((grid, paneIndex) => (
                    <div className="m-pane" key={panes[paneIndex]} aria-hidden={paneIndex !== 1}>
                      <div className="m-grid">
                        {grid.map((d) => {
                          const inMonth = d.slice(0, 7) === panes[paneIndex].slice(0, 7)
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
                              tabIndex={paneIndex === 1 ? 0 : -1}
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
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 当天详情：日期标题 + 合并后的任务/事件列表 */}
              <div className="m-day">
                <div className="m-day-head">
                  <span className="m-day-title">{dayLabel(date)}</span>
                  {date !== today && (
                    <button className="m-today-btn" onClick={() => setDate(today)}>
                      今天
                    </button>
                  )}
                </div>

                {/* 任务是"只属于这一天"，事件是"可以重复的任务"，本质是同一件事，
                    所以合成一张卡片，只用一个标签区分。 */}
                <div className="m-section">
                  <div className="m-card">
                    {dayItems.length === 0 ? (
                      <div className="m-empty">这一天还没有安排</div>
                    ) : (
                      dayItems.map((it, rowIndex) =>
                        it.type === 'event' ? (
                          <SwipeRow
                            key={`e-${it.occ.event.id}-${it.occ.date}`}
                            onDelete={() => requestRemoveEvent(it.occ)}
                            /* 重复待办会先弹确认框：别让这一行提前塌掉 */
                            hold={Boolean(it.occ.event.rrule)}
                            style={{ animationDelay: `${Math.min(rowIndex, 9) * 24}ms` }}
                          >
                            <div className="m-task">
                              <button
                                className={`m-task-check ${it.occ.done ? 'm-task-check-on' : ''}`}
                                onClick={() => void toggleEvent(it.occ)}
                                aria-label={it.occ.done ? '取消完成' : '完成'}
                              >
                                {it.occ.done && Icon.check}
                              </button>
                              <span className={`m-task-text ${it.occ.done ? 'm-task-done' : ''}`}>
                                <span className="m-task-label">{it.occ.event.title}</span>
                              </span>
                              {eventKindLabel(it.occ.event) && (
                                <span className="m-task-tag">{eventKindLabel(it.occ.event)}</span>
                              )}
                              <button
                                className="m-task-del"
                                onClick={() => requestRemoveEvent(it.occ)}
                                aria-label="删除"
                              >
                                {Icon.x}
                              </button>
                            </div>
                          </SwipeRow>
                        ) : (
                          // key 用稳定身份：勾选/删除别的行都不会让这一行换壳
                          <SwipeRow
                            key={it.rowKey}
                            onDelete={() => removeTask(it.index)}
                            style={{ animationDelay: `${Math.min(rowIndex, 9) * 24}ms` }}
                          >
                            <div className="m-task">
                              <button
                                className={`m-task-check ${
                                  (pendingDone?.index === it.index ? pendingDone.done : it.done)
                                    ? 'm-task-check-on'
                                    : ''
                                }`}
                                onClick={() => toggleTask(it.index)}
                                aria-label={it.done ? '取消完成' : '完成'}
                              >
                                {(pendingDone?.index === it.index ? pendingDone.done : it.done) &&
                                  Icon.check}
                              </button>
                              <span
                                className={`m-task-text ${
                                  (pendingDone?.index === it.index ? pendingDone.done : it.done)
                                    ? 'm-task-done'
                                    : ''
                                }`}
                              >
                                <span className="m-task-label">{lineText(it.text)}</span>
                              </span>
                              <button
                                className="m-task-del"
                                onClick={() => removeTask(it.index)}
                                aria-label="删除"
                              >
                                {Icon.x}
                              </button>
                            </div>
                          </SwipeRow>
                        )
                      )
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === 'upcoming' && (
            <div className="m-list">
              {upcoming.length === 0 ? (
                <div className="m-empty">没有即将到来的待办</div>
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
                          // 退出登录要把缓存清掉：换个账号登进来不能看到上一个人的日历
                          clearCache()
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
                              // 乐观删除：先把这行拿走，失败再放回来
                              const snapshot = calendars
                              const rest = calendars.filter((x) => x.id !== c.id)
                              setConfirmCal(null)
                              setCalendars(rest)
                              if (calId === c.id) setCalId(rest[0]?.id ?? '')
                              void data.calendars.remove(c.id).then((res) => {
                                if (!res.ok) {
                                  setCalendars(snapshot)
                                  if (calId === c.id) setCalId(c.id)
                                  say(res.error)
                                  return
                                }
                                setCalendars(res.data)
                                if (calId === c.id) setCalId(res.data[0]?.id ?? '')
                                say('已删除')
                              })
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
                          {Icon.x}
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
                      disabled={!newCal.trim()}
                      onClick={() => {
                        const name = newCal.trim()
                        if (!name || calBusy) return
                        // 颜色和桌面端同一套规则：挑第一支没用过的
                        const color = nextCalendarColor(calendars.map((c) => c.color))
                        const tmpId = `tmp:${Date.now()}`
                        const now = Date.now()
                        // 乐观插入：输入框立刻清空、列表立刻多一行，不等网络
                        setCalendars((prev) => [
                          ...prev,
                          {
                            id: tmpId,
                            name,
                            color,
                            sort: prev.length,
                            createdAt: now,
                            updatedAt: now,
                            deletedAt: null
                          }
                        ])
                        setNewCal('')
                        setCalBusy(true)
                        void data.calendars.create(name, color).then((res) => {
                          setCalBusy(false)
                          if (!res.ok) {
                            setCalendars((prev) => prev.filter((c) => c.id !== tmpId))
                            setNewCal(name)
                            say(res.error)
                            return
                          }
                          setCalendars(res.data.calendars)
                          setCalId(res.data.created.id)
                          say('已新建')
                        })
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
        </div>
      </div>

      {/* 液态玻璃底栏：弹层打开时整条收起，别顶到键盘上面去 */}
      <GlassDock
        hidden={adding}
        items={[
          { key: 'month', label: '日历', icon: Icon.calendar },
          { key: 'upcoming', label: '即将', icon: Icon.clock },
          { key: 'settings', label: '设置', icon: Icon.settings }
        ]}
        active={tab}
        onSelect={(k) => {
          // 底栏从左到右就是页面的先后：往右的标签从右边进来，读起来才顺
          const order: Tab[] = ['month', 'upcoming', 'settings']
          const to = order.indexOf(k as Tab)
          setViewMotion(to >= order.indexOf(tab) ? 'next' : 'prev')
          setTab(k as Tab)
        }}
        onAdd={() => setAdding(true)}
      />

      {/* 添加任务弹层：常驻 DOM，开合只改 class，省掉一层挂载/卸载 */}
      <div
        className={`m-sheet-mask ${adding ? 'is-open' : ''}`}
        onClick={() => setAdding(false)}
        aria-hidden={!adding}
      />
      <div className={`m-sheet ${adding ? 'is-open' : ''}`} aria-hidden={!adding}>
        <div className="m-sheet-handle" />
        <div className="m-sheet-title">添加到 {dayLabel(date).split(' ')[0]}</div>
        <div className="m-sheet-add-row">
          <input
            ref={draftRef}
            className="m-sheet-input"
            placeholder="要做什么？"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addTask()
            }}
          />
          <RepeatChip rule={newRepeat} baseDate={date} onChange={(rule) => setNewRepeat(rule)} />
        </div>
        <div className="m-sheet-actions">
          <button className="m-btn" onClick={() => setAdding(false)}>
            取消
          </button>
          <button className="m-btn m-btn-primary" disabled={!draft.trim()} onClick={addTask}>
            添加
          </button>
        </div>
      </div>

      <div className={`m-toast ${toast ? 'is-open' : ''}`} role="status">
        {toast}
      </div>

      {/* 删重复待办的确认框：常驻 DOM，开合只改 class */}
      <div
        className={`m-confirm-mask ${confirmEvent ? 'is-open' : ''}`}
        onClick={() => setConfirmEvent(null)}
        aria-hidden={!confirmEvent}
      />
      <div
        className={`m-confirm ${confirmEvent ? 'is-open' : ''}`}
        aria-hidden={!confirmEvent}
        role="dialog"
        aria-label="删除重复待办"
      >
        <div className="m-confirm-handle" />
        <div className="m-confirm-title">删除重复待办</div>
        <div className="m-confirm-text">
          「{confirmEvent?.event.title ?? ''}」是重复待办，要删除哪一部分？
        </div>
        <div className="m-confirm-actions">
          <button className="m-btn" onClick={() => setConfirmEvent(null)}>
            取消
          </button>
          <button
            className="m-btn"
            onClick={() => {
              if (confirmEvent) void skipOneOccurrence(confirmEvent)
            }}
          >
            仅删除 {confirmEvent?.date.slice(5)} 这天
          </button>
          <button
            className="m-btn m-btn-danger"
            onClick={() => {
              if (confirmEvent) {
                removeEvent(confirmEvent)
                setConfirmEvent(null)
              }
            }}
          >
            删除整个重复
          </button>
        </div>
      </div>
    </div>
  )
}
