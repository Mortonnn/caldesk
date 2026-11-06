import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import {
  CalMark,
  Check,
  ChevronLeft,
  ChevronRight,
  Menu,
  Note as NoteIcon,
  PanelLeft,
  Plus,
  Search,
  Settings,
  WinClose,
  WinMaximize,
  WinMinimize,
  WinRestore,
  X
} from './icons'
import { DROPLET, DUR, EASE_EMPHASIZED, EASE_IN, EASE_OUT, fade, panelIn, scrimFade } from './motion'
import { RepeatChip } from './RepeatChip'
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths
} from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { getThemeMode, setThemeMode, THEME_LABEL, THEME_ORDER, type ThemeMode } from './theme'
import type {
  CalendarMeta,
  DayCell,
  EventKind,
  EventOccurrence,
  Note,
  SearchHit,
  SnapshotMeta
} from '@shared/types'
import { isDoneLine, lineText, splitLines } from '@shared/types'
import { describeRrule, toDayNumber, weekdayOf } from '@shared/rrule'
import { DEFAULT_SERVER_URL } from '@shared/identity'
import { data } from './data'
import { generateStrongPassword } from './password'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/** 历史默认露出几条，剩下的折叠 */
const SNAP_PREVIEW = 5

type RepeatPreset = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'

const REPEAT_LABEL: Record<RepeatPreset, string> = {
  none: '不重复',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
  custom: '自定义…'
}

const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

const TABLE_LABEL: Record<string, string> = {
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
const sheetSwap: Variants = {
  // 换页：单轴 X + 淡入，距离和手机端对齐（28px / 240ms，emphasized 曲线）
  initial: (dir: number) => (dir === 0 ? { opacity: 1, x: 0 } : { opacity: 0, x: 24 * dir }),
  animate: { opacity: 1, x: 0, transition: { duration: DUR.page, ease: EASE_EMPHASIZED } },
  exit: (dir: number) =>
    dir === 0
      ? { opacity: 0, transition: { duration: 0 } }
      : { opacity: 0, x: -12 * dir, transition: { duration: DUR.fast, ease: EASE_IN } }
}

/** 回滚记录的时间戳：当天只显示时分，跨天带上日期 */
function stampOf(ts: number): string {
  const d = new Date(ts)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? `今天 ${format(d, 'HH:mm')}` : format(d, 'M月d日 HH:mm')
}

/** Windows 11 标题栏按钮的绘制尺寸，与系统原生按钮一致 */

/**
 * 把 'yyyy-MM-dd' 解析为**本地**零点的 Date。
 * 不能用 new Date(iso)：那会按 UTC 解析，在 UTC 负偏移时区会退到前一天，
 * 导致详情面板显示的星期与网格里的格子对不上。
 */
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * 格子里一共留几行给内容：先放事件，再放任务行，放不下就用一行 "+N" 收尾。
 * 行数由格子的实际高度算出来，所以在 1080p 是 3 行、4K 下能到 6~8 行。
 */
function layoutCell(
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

export default function App(): React.JSX.Element {
  const [cursor, setCursor] = useState(() => new Date())
  const [calendars, setCalendars] = useState<CalendarMeta[]>([])
  const [activeCal, setActiveCal] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [calError, setCalError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(format(new Date(), 'yyyy-MM-dd'))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [maximized, setMaximized] = useState(false)
  const [miniVisible, setMiniVisible] = useState(false)
  /** 开机自启动：默认开，登录后安静进托盘 */
  const [autoStart, setAutoStart] = useState(true)
  /** 关闭主窗口时收进托盘（设置里可关） */
  const [closeToTray, setCloseToTray] = useState(true)
  const [cells, setCells] = useState<Record<string, string>>({})
  const [draftTask, setDraftTask] = useState('')
  /** 新建待办时选的重复规则；默认不重复，加完自动回到不重复 */
  const [newRepeat, setNewRepeat] = useState<string | null>(null)
  const [cellError, setCellError] = useState<string | null>(null)
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([])
  const [eventTitle, setEventTitle] = useState('')
  const [eventKind, setEventKind] = useState<EventKind>('task')
  const [eventRepeat, setEventRepeat] = useState<RepeatPreset>('none')
  const [eventError, setEventError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'none' | 'notes' | 'search' | 'settings'>('none')
  /** 轮询探不到服务器时置真，只在顶栏亮一枚小标，不打断任何操作 */
  const [offline, setOffline] = useState(false)
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([])
  const [snapMsg, setSnapMsg] = useState<string | null>(null)
  /** 历史默认只露 5 条，多的点开看 */
  const [snapExpanded, setSnapExpanded] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [panelError, setPanelError] = useState<string | null>(null)
  const [syncUrl, setSyncUrl] = useState('')
  const [syncDeviceName, setSyncDeviceName] = useState('')
  const [syncAccountId, setSyncAccountId] = useState('')
  const [syncUsername, setSyncUsername] = useState('')
  const [syncPaired, setSyncPaired] = useState(false)
  /** 没登录时显示登录还是注册 */
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authUser, setAuthUser] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authInvite, setAuthInvite] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [deviceList, setDeviceList] = useState<
    Array<{
      deviceId: string
      name: string
      status: string
      lastSeenAt: number | null
      lastIp: string | null
      current: boolean
    }>
  >([])
  const [syncOnline, setSyncOnline] = useState(0)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [customDays, setCustomDays] = useState(2)
  /** 事件表单默认收起：多数人进详情面板只是勾任务 */
  const [eventOpen, setEventOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<EventOccurrence | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('caldesk.sidebarCollapsed') === '1'
  )
  const [detailWidth, setDetailWidth] = useState(() => {
    const saved = Number(localStorage.getItem('caldesk.detailWidth'))
    return Number.isFinite(saved) && saved >= 300 ? saved : 400
  })

  /** 拖动详情面板左边缘调整宽度 */
  function startResize(e: import('react').PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = detailWidth
    const maxWidth = Math.min(Math.round(window.innerWidth * 0.62), 760)

    const onMove = (ev: PointerEvent): void => {
      const next = Math.min(Math.max(startWidth + (startX - ev.clientX), 300), maxWidth)
      setDetailWidth(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDetailWidth((w) => {
        localStorage.setItem('caldesk.detailWidth', String(Math.round(w)))
        return w
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function toggleSidebar(): void {
    setSidebarCollapsed((v) => {
      localStorage.setItem('caldesk.sidebarCollapsed', v ? '0' : '1')
      return !v
    })
  }

  useEffect(() => {
    void data.settings.get().then((s) => {
      setMiniVisible(s.miniVisible)
      setAutoStart(s.autoStart)
      setCloseToTray(s.closeToTray)
    })
    void getThemeMode().then(setTheme)
    void data.sync.getState().then((s) => {
      setSyncUrl(s.serverUrl)
      setSyncDeviceName(s.deviceName)
      setSyncAccountId(s.accountId)
      setSyncUsername(s.username)
      setSyncPaired(s.paired)
    })
    void data.calendars.list().then((res) => {
      if (!res.ok) {
        setCalError(res.error)
        return
      }
      setCalendars(res.data)
      setActiveCal((prev) => prev ?? res.data[0]?.id ?? null)
    })
  }, [])

  /** 保存服务器地址与本机设备名 */
  async function saveSyncServer(): Promise<void> {
    const res = await data.sync.setServer(syncUrl.trim(), syncDeviceName.trim())
    setSyncUrl(res.serverUrl)
    setSyncDeviceName(res.deviceName)
    setSyncPaired(res.paired)
    if (res.loggedOut) {
      setSyncAccountId('')
      setSyncUsername('')
      setDeviceList([])
      setSyncMsg('换了服务器，请重新登录')
    } else {
      setSyncMsg('已保存')
    }
  }

  function fillStrongPassword(): void {
    const pw = generateStrongPassword()
    setAuthPassword(pw)
    void navigator.clipboard?.writeText(pw).catch(() => {})
    setSyncMsg('已生成强密码并复制到剪贴板')
  }

  /** 登录 / 注册：任意设备登录同一账号，就绑到同一份数据上 */
  async function submitAuth(): Promise<void> {
    const username = authUser.trim()
    if (!username || !authPassword) {
      setSyncMsg('请填写用户名和密码')
      return
    }
    setAuthBusy(true)
    setSyncMsg(authMode === 'login' ? '正在登录…' : '正在注册…')
    const res =
      authMode === 'login'
        ? await data.sync.login({ username, password: authPassword })
        : await data.sync.register({ username, password: authPassword, invite: authInvite.trim() })
    setAuthBusy(false)
    if (!res.ok) {
      setSyncMsg(`${authMode === 'login' ? '登录' : '注册'}失败：${res.error}`)
      return
    }
    setSyncAccountId(res.data.accountId)
    setSyncUsername(res.data.username)
    setSyncPaired(true)
    setAuthPassword('')
    setSyncMsg(authMode === 'login' ? '已登录，正在同步…' : '账号已创建，手机用同一个账号登录即可')
    void refreshDevices()
    await runSyncNow()
  }

  /** 配对时代的老账号：用现有凭据设一次用户名密码，数据一行不动 */
  async function claimExisting(): Promise<void> {
    const username = authUser.trim()
    if (!username || !authPassword) {
      setSyncMsg('请填写用户名和密码')
      return
    }
    setAuthBusy(true)
    const res = await data.sync.claim({ username, password: authPassword })
    setAuthBusy(false)
    if (!res.ok) {
      setSyncMsg(`设置失败：${res.error}`)
      return
    }
    setSyncUsername(res.data.username)
    setAuthPassword('')
    setSyncMsg('已设置用户名密码，其他设备可以直接登录了')
  }

  async function logoutSync(): Promise<void> {
    await data.sync.logout()
    setSyncPaired(false)
    setSyncAccountId('')
    setSyncUsername('')
    setDeviceList([])
    setSyncMsg('已退出登录，本机数据还在')
  }

  /** 设备列表 + 在线数 */
  async function refreshDevices(): Promise<void> {
    const res = await data.sync.devices()
    if (res.ok) {
      setDeviceList(res.data.devices)
      setSyncOnline(res.data.online)
    }
  }

  useEffect(() => {
    if (syncPaired) void refreshDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPaired])

  async function revokeDevice(deviceId: string): Promise<void> {
    const res = await data.sync.revokeDevice(deviceId)
    setSyncMsg(res.ok ? '已删除该设备' : `删除失败：${res.error}`)
    void refreshDevices()
  }

  async function runSyncNow(): Promise<void> {
    setSyncing(true)
    setSyncMsg('同步中…')
    const r = await data.sync.run()
    setSyncing(false)
    setSyncMsg(
      r.ok
        ? `完成：上传 ${r.pushed}，下载 ${r.pulled}${r.failed > 0 ? `，失败 ${r.failed}` : ''}`
        : (r.error ?? '同步失败')
    )
  }

  /* --------------------------- 回滚 --------------------------- */

  /** 回滚后把界面拉回与库一致：视图列表、当月日格、当月事件 */
  async function refresh(): Promise<void> {
    await reloadAll()
  }

  async function loadSnaps(): Promise<void> {
    const list = await data.snapshots.list()
    setSnaps(list)
  }

  async function restoreSnap(id: string): Promise<void> {
    const res = await data.snapshots.restore(id)
    if (!res.ok) {
      setSnapMsg(res.error)
      return
    }
    const { restored, deleted, failed } = res.data
    setSnapMsg(
      `已回到该时间点：恢复 ${restored} 条、删除 ${deleted} 条${failed > 0 ? `，失败 ${failed}` : ''}`
    )
    await loadSnaps()
    await refresh()
  }

  async function clearSnaps(): Promise<void> {
    const n = await data.snapshots.clear()
    setSnapMsg(`已清空 ${n} 条记录`)
    await loadSnaps()
  }

  async function submitNew(): Promise<void> {
    const name = draftName.trim()
    if (!name) {
      setAdding(false)
      return
    }
    const res = await data.calendars.create(name)
    if (!res.ok) {
      setCalError(res.error)
      return
    }
    setCalendars(res.data.calendars)
    setActiveCal(res.data.created.id)
    setDraftName('')
    setAdding(false)
    setCalError(null)
  }

  async function removeCalendar(id: string): Promise<void> {
    const res = await data.calendars.remove(id)
    if (!res.ok) {
      setCalError(res.error)
      return
    }
    setCalendars(res.data)
    setActiveCal((prev) => (prev === id ? (res.data[0]?.id ?? null) : prev))
    setCalError(null)
  }

  useEffect(() => {
    void data.window.isMaximized().then(setMaximized)
    return data.window.onMaximizedChange(setMaximized)
  }, [])

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
  /** 换页键：视图或月份变一次换一张；同月内增删任务不换，免得整片闪一下 */
  const gridKey = `${activeCal}|${format(cursor, 'yyyy-MM')}`

  /*
   * 换页方向：只决定沿 X 从哪边进、往哪边退。
   * 放在 ref 里算——同一帧就要用，走 state 会慢一帧。
   */
  const monthDir = useRef(1)
  const prevCursor = useRef(cursor)
  if (prevCursor.current !== cursor) {
    monthDir.current = cursor.getTime() > prevCursor.current.getTime() ? 1 : -1
    prevCursor.current = cursor
  }
  const dayDir = useRef(1)
  const prevSelected = useRef(selected)
  if (prevSelected.current !== selected) {
    dayDir.current = (selected ?? '') > (prevSelected.current ?? '') ? 1 : -1
    prevSelected.current = selected
  }
  /* 首次拿到视图（null → id）是加载完成，不是翻页：方向给 0，直接定格 */
  const gridDir = useRef(1)
  const prevGridKey = useRef(gridKey)
  const prevGridCal = useRef(activeCal)
  if (prevGridKey.current !== gridKey) {
    const calChanged = prevGridCal.current !== activeCal
    gridDir.current = prevGridCal.current === null ? 0 : calChanged ? 1 : monthDir.current
    prevGridKey.current = gridKey
    prevGridCal.current = activeCal
  }
  /* 系统要求减少动态时换页只淡入淡出，不留位移 */
  const reduced = useReducedMotion()
  const swapVariants: Variants = reduced ? fade : sheetSwap

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

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 })
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 })
    return eachDayOfInterval({ start, end })
  }, [cursor])

  const current = calendars.find((c) => c.id === activeCal) ?? calendars[0]

  const monthRange = useMemo(
    () => ({
      from: format(days[0], 'yyyy-MM-dd'),
      to: format(days[days.length - 1], 'yyyy-MM-dd')
    }),
    [days]
  )

  // 切换视图或翻月时重新加载日格与事件
  const loadRange = useCallback(
    async (calendarId: string): Promise<void> => {
      const [cellsRes, eventsRes] = await Promise.all([
        data.cells.range(calendarId, monthRange.from, monthRange.to),
        data.events.range(calendarId, monthRange.from, monthRange.to)
      ])
      if (cellsRes.ok) {
        const next: Record<string, string> = {}
        for (const cell of cellsRes.data) next[cell.date] = cell.text
        setCells(next)
      } else {
        setCellError(cellsRes.error)
      }
      if (eventsRes.ok) setOccurrences(eventsRes.data)
      else setEventError(eventsRes.error)
    },
    [monthRange]
  )

  /** 当前选中的日历：用 ref 让刷新函数保持稳定，订阅不必随状态重建 */
  const activeCalRef = useRef<string | null>(null)
  useEffect(() => {
    activeCalRef.current = activeCal
  }, [activeCal])

  /**
   * 从本地库整体重读一遍：日历列表 + 当月内容。
   *
   * 只重读日格是不够的：别的设备（手机 / AI / CLI）新建的日历写进 calendars 表以后，
   * 侧栏不重读就永远看不见它 —— 用户看到的就是"手机上加的日历电脑上没有"。
   */
  const reloadAll = useCallback(async (): Promise<void> => {
    const res = await data.calendars.list()
    if (!res.ok) {
      setCalError(res.error)
      const cur = activeCalRef.current
      if (cur) await loadRange(cur)
      return
    }
    setCalendars(res.data)
    setCalError(null)
    const keep = activeCalRef.current
    const next = keep && res.data.some((c) => c.id === keep) ? keep : (res.data[0]?.id ?? null)
    // 选中的日历还在就原地刷新；被别的设备删了才换一个
    if (next !== keep) setActiveCal(next)
    if (next) await loadRange(next)
  }, [loadRange])

  useEffect(() => {
    if (!activeCal) return
    void loadRange(activeCal)
  }, [activeCal, loadRange])

  // 浮窗、另一处编辑、或者一次同步带回了新数据：整块重读，别只翻日格
  useEffect(() => {
    return data.onDataChanged(() => void reloadAll())
  }, [reloadAll])

  // 同步跑完（含"立即同步"和后台每 5 分钟那次）：有下载就重读
  useEffect(() => {
    return data.sync.onDone((r) => {
      setSyncMsg(r.ok ? `同步完成：上传 ${r.pushed}，下载 ${r.pulled}` : '同步失败')
      if (r.ok && r.pulled > 0) void reloadAll()
    })
  }, [reloadAll])

  /**
   * 热更新：定期问服务端"有没有新东西"。
   *
   * 之前只有本机改动才会刷新，别的设备（手机、AI、CLI）改完，
   * 这边必须退出重进才看得到。现在探到水位变了就立刻拉一次。
   */
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const probe = await data.sync.changes()
        if (stopped) return
        // 连不上要能看见：以前失败和"没变更"都返回 changed:false，界面完全没提示
        setOffline(probe.ok === false)
        if (probe.changed) {
          // 有新东西：先同步进本地库，再整块重读（日历列表也可能变了）
          await data.sync.run()
          if (!stopped) await reloadAll()
        }
      } catch {
        if (!stopped) setOffline(true)
      }
      if (!stopped) timer = setTimeout(() => void tick(), 5000)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [reloadAll])

  function applyCell(cell: DayCell): void {
    setCells((prev) => ({ ...prev, [cell.date]: cell.text }))
    setCellError(null)
  }

  /**
   * 本地先改，提交在后台跑。
   *
   * 桌面端写的是本地 SQLite，本来就不过网络，可界面还是干等一次 IPC 往返
   * 才出新行 —— 写完再 applyCell(row) 的老路数，用户看到的是"按了没反应"。
   * 现在先改内存，服务器/库回包以后再对齐，失败回滚。
   */
  function optimisticCell(date: string, nextText: string): void {
    setCells((prev) => ({ ...prev, [date]: nextText }))
    setCellError(null)
  }

  async function addTask(date: string): Promise<void> {
    const text = draftTask.trim()
    if (!text || !activeCal) return
    // 输入框右边的重复按钮选了规则：直接建一条会重复的待办（events 表，带 rrule）
    if (newRepeat) {
      const rule = newRepeat
      /*
       * 先在本地造一条临时记录画上去，再提交。
       * 以前是"等回包 → 再整块重拉"，两趟。
       */
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setOccurrences((prev) => [
        ...prev,
        {
          date,
          done: false,
          event: {
            id: tempId,
            calendarId: activeCal,
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
      ])
      setDraftTask('')
      // 加完回到"不重复"，下一次默认还是普通待办
      setNewRepeat(null)
      const created = await data.events.create({
        calendarId: activeCal,
        kind: 'task',
        title: text,
        start: date,
        allDay: true,
        rrule: rule
      })
      if (!created.ok) {
        setOccurrences((prev) => prev.filter((x) => x.event.id !== tempId))
        setEventError(created.error)
        setDraftTask(text)
        setNewRepeat(rule)
        return
      }
      // 用真实记录换掉临时那条（拿到真 id，后续勾选/删除才对得上）
      setOccurrences((prev) =>
        prev.map((x) => (x.event.id === tempId ? { ...x, event: created.data } : x))
      )
      return
    }
    const base = cells[date] ?? ''
    const nextText = base.trim() ? `${base.replace(/\s+$/, '')}\n${text}` : text
    optimisticCell(date, nextText)
    setDraftTask('')
    const res = await data.cells.appendLine(activeCal, date, text)
    if (!res.ok) {
      // 回滚到提交前的样子，文字放回输入框
      optimisticCell(date, base)
      setCellError(res.error)
      setDraftTask(text)
      return
    }
    applyCell(res.data)
  }

  /** 正在播完成动画的任务行：点上先原地播 300ms，播完才写库重排 */
  const [pendingLine, setPendingLine] = useState<{ index: number; done: boolean } | null>(null)
  const pendingLineTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (pendingLineTimer.current) clearTimeout(pendingLineTimer.current)
    },
    []
  )

  function toggleLine(date: string, index: number, done: boolean): void {
    if (!activeCal || pendingLine !== null) return
    setPendingLine({ index, done })
    if (pendingLineTimer.current) clearTimeout(pendingLineTimer.current)
    pendingLineTimer.current = setTimeout(() => {
      setPendingLine(null)
      void data.cells.setDone(activeCal, date, index, done).then((res) => {
        if (res.ok) applyCell(res.data)
        else setCellError(res.error)
      })
    }, 300)
  }

  async function removeLine(date: string, index: number): Promise<void> {
    if (!activeCal) return
    // 先从界面上拿掉，再去删
    const base = cells[date] ?? ''
    const rest = splitLines(base)
    rest.splice(index, 1)
    optimisticCell(date, rest.join('\n'))
    const res = await data.cells.deleteLine(activeCal, date, index)
    if (!res.ok) {
      optimisticCell(date, base)
      setCellError(res.error)
      return
    }
    applyCell(res.data)
  }

  /**
   * 改某一行的重复规则。
   *
   * 数据上「不重复的待办」是日格里的一行文本，「会重复的待办」是 events 表里
   * 一条 kind=task 的记录 —— 只有事件才带 rrule、才会在别的日期展开出现。
   * 所以这里做的是两种形态之间的搬运：
   *   - 文本行 → 选了规则：先建事件，成功后再删掉那行文本（顺序不能反，否则丢内容）
   *   - 事件行 → 选了"不重复"：删事件，把标题写回当天一行文本
   */
  async function setRowRepeat(
    item:
      | { type: 'line'; index: number; text: string }
      | { type: 'event'; occ: EventOccurrence },
    rule: string | null
  ): Promise<void> {
    if (!activeCal || !selected) return
    const date = selected

    /*
     * 一律先改本地再提交：
     * 以前这里是"等写完 → 再整块重拉"，两趟往返。
     * 现在界面立刻变形，提交在后台跑，失败整块回滚。
     */
    const snapCells = cells
    const snapOcc = occurrences

    if (item.type === 'event') {
      const ev = item.occ.event
      if (rule) {
        setOccurrences((prev) =>
          prev.map((x) =>
            x.event.id === ev.id ? { ...x, event: { ...x.event, rrule: rule } } : x
          )
        )
        const res = await data.events.update(ev.id, { rrule: rule })
        if (!res.ok) {
          setOccurrences(snapOcc)
          setEventError(res.error)
          return
        }
        return
      }
      // 事件 → 不重复：界面上换成一行文本
      const rest = splitLines(snapCells[date] ?? '')
      optimisticCell(date, rest.length ? `${rest.join('\n')}\n${ev.title}` : ev.title)
      setOccurrences((prev) => prev.filter((x) => x.event.id !== ev.id))
      const res = await data.events.remove(ev.id)
      if (!res.ok) {
        setOccurrences(snapOcc)
        optimisticCell(date, snapCells[date] ?? '')
        setEventError(res.error)
        return
      }
      const back = await data.cells.appendLine(activeCal, date, ev.title)
      if (!back.ok) {
        setOccurrences(snapOcc)
        optimisticCell(date, snapCells[date] ?? '')
        setEventError(back.error)
      }
      return
    }

    if (!rule) return
    const title = lineText(item.text)
    if (!title) return
    // 文本行 → 会重复的待办：本地先换形态
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const rest = splitLines(snapCells[date] ?? '')
    rest.splice(item.index, 1)
    optimisticCell(date, rest.join('\n'))
    setOccurrences((prev) => [
      ...prev,
      {
        date,
        done: false,
        event: {
          id: tempId,
          calendarId: activeCal,
          kind: 'task',
          title,
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
    ])
    const created = await data.events.create({
      calendarId: activeCal,
      kind: 'task',
      title,
      start: date,
      allDay: true,
      rrule: rule
    })
    if (!created.ok) {
      setOccurrences(snapOcc)
      optimisticCell(date, snapCells[date] ?? '')
      setEventError(created.error)
      return
    }
    setOccurrences((prev) =>
      prev.map((x) => (x.event.id === tempId ? { ...x, event: created.data } : x))
    )
    const gone = await data.cells.deleteLine(activeCal, date, item.index)
    if (!gone.ok) {
      // 事件建好了但原文本行没删掉：回滚，别留两份
      setOccurrences(snapOcc)
      optimisticCell(date, snapCells[date] ?? '')
      setEventError(gone.error)
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  const eventsByDate = useMemo(() => {
    const map: Record<string, EventOccurrence[]> = {}
    for (const occ of occurrences) {
      ;(map[occ.date] ??= []).push(occ)
    }
    return map
  }, [occurrences])

  function ruleFromPreset(preset: RepeatPreset, date: string): string | null {
    switch (preset) {
      case 'daily':
        return 'FREQ=DAILY'
      case 'weekly':
        return `FREQ=WEEKLY;BYDAY=${BYDAY[weekdayOf(toDayNumber(date))]}`
      case 'monthly':
        return 'FREQ=MONTHLY'
      case 'yearly':
        return 'FREQ=YEARLY'
      case 'custom':
        // 自定义只做一件事：每 N 天重复一次。填数字就够，不用懂 RRULE
        return `FREQ=DAILY;INTERVAL=${Math.max(1, Math.min(365, Math.round(customDays) || 1))}`
      default:
        return null
    }
  }

  async function addEvent(date: string): Promise<void> {
    if (!activeCal) return
    const title = eventTitle.trim()
    if (!title) return
    const rule = ruleFromPreset(eventRepeat, date)
    /*
     * 先在本地造一条画上去，提交在后台跑。
     * 以前是"等回包 → 再整块重拉当月"，两趟。
     */
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setOccurrences((prev) => [
      ...prev,
      {
        date,
        done: false,
        event: {
          id: tempId,
          calendarId: activeCal,
          kind: eventKind,
          title,
          notes: null,
          allDay: true,
          start: date,
          end: null,
          rrule: rule,
          remindMinutes: eventKind === 'reminder' ? 0 : null,
          targetDate: eventKind === 'countdown' ? date : null,
          color: null,
          completed: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          deletedAt: null
        }
      }
    ])
    setEventTitle('')
    setEventError(null)
    const res = await data.events.create({
      calendarId: activeCal,
      kind: eventKind,
      title,
      start: date,
      rrule: rule,
      targetDate: eventKind === 'countdown' ? date : null,
      remindMinutes: eventKind === 'reminder' ? 0 : null
    })
    if (!res.ok) {
      setOccurrences((prev) => prev.filter((x) => x.event.id !== tempId))
      setEventTitle(title)
      setEventError(res.error)
      return
    }
    setOccurrences((prev) =>
      prev.map((x) => (x.event.id === tempId ? { ...x, event: res.data } : x))
    )
  }

  async function toggleEventDone(occ: EventOccurrence): Promise<void> {
    // 先亮状态，提交在后台跑
    const next = !occ.done
    setOccurrences((prev) =>
      prev.map((item) =>
        item.event.id === occ.event.id && item.date === occ.date
          ? { ...item, done: next }
          : item
      )
    )
    const res = await data.events.setDone(occ.event.id, occ.date, next)
    if (!res.ok) {
      setOccurrences((prev) =>
        prev.map((item) =>
          item.event.id === occ.event.id && item.date === occ.date
            ? { ...item, done: occ.done }
            : item
        )
      )
      setEventError(res.error)
    }
  }

  /** 重复任务先问「只删本次 / 删整个重复」 */
  async function requestRemoveEvent(occ: EventOccurrence): Promise<void> {
    if (!occ.event.rrule) {
      await removeEvent(occ.event.id)
      return
    }
    setConfirmDelete(occ)
  }

  async function skipOne(): Promise<void> {
    if (!confirmDelete || !activeCal) return
    /*
     * 「仅删本次」在数据上是往 event_skip 里插一条，
     * 列表时这一天的实例就被滤掉了 —— 所以界面上要把这一行整个拿掉，
     * 不是标成完成。
     */
    const target = confirmDelete
    const snapOcc = occurrences
    setOccurrences((prev) =>
      prev.filter((x) => !(x.event.id === target.event.id && x.date === target.date))
    )
    setConfirmDelete(null)
    const res = await data.events.skip(target.event.id, target.date)
    if (!res.ok) {
      setOccurrences(snapOcc)
      setEventError(res.error)
    }
  }

  /** 重复任务先问「只删本次 / 删整个重复」 */
  async function removeEvent(id: string): Promise<void> {
    // 先从界面上拿掉
    const snapOcc = occurrences
    setOccurrences((prev) => prev.filter((x) => x.event.id !== id))
    const res = await data.events.remove(id)
    if (!res.ok) {
      setOccurrences(snapOcc)
      setEventError(res.error)
      return
    }
  }

  function countdownText(target: string | null, date: string): string | null {
    if (!target) return null
    const days = toDayNumber(target) - toDayNumber(date)
    if (days === 0) return '今天'
    return days > 0 ? `还有 ${days} 天` : `已过 ${-days} 天`
  }

  const selectedEvents = selected ? (eventsByDate[selected] ?? []) : []
  const selectedLines = selected ? splitLines(cells[selected] ?? '') : []

  /**
   * 任务和事件合并成一个列表。
   *
   * 用户视角它们是同一件事：都是"某天要做的事"，
   * 区别只是任务只属于这一天，事件可以重复。
   *
   * 排序：未完成在上、已完成在下；组内保持创建顺序
   * （事件按 createdAt，任务行按行号；稳定排序不会打乱组内次序）。
   */
  const selectedItems = [
    // 先文本行（行号即创建顺序）、后重复待办（createdAt）；再按完成与否稳定排序。
    // 这样"后创建的"不会因为存在 events 表里就跑到最上面。
    ...selectedLines
      .map((text, index) => ({
        type: 'line' as const,
        text,
        index,
        done: isDoneLine(text),
        // pending 期间只改外观、不改排序字段：行留在原位播完 300ms 才重排（MIUI 笔记）
        visualDone: pendingLine?.index === index ? pendingLine.done : isDoneLine(text)
      }))
      .filter((l) => l.text.trim().length > 0),
    ...selectedEvents
      .slice()
      .sort((a, b) => (a.event.createdAt ?? 0) - (b.event.createdAt ?? 0))
      .map((occ) => ({ type: 'event' as const, occ, done: occ.done, visualDone: occ.done }))
  ].sort((a, b) => Number(a.done) - Number(b.done))

  /* ------------------------------ 便签与搜索 ------------------------------ */

  const loadNotes = useCallback(async (): Promise<void> => {
    const res = await data.notes.list(activeCal ?? undefined)
    if (res.ok) {
      setNotes(res.data)
      setPanelError(null)
    } else {
      setPanelError(res.error)
    }
  }, [activeCal])

  useEffect(() => {
    if (panel === 'notes') void loadNotes()
  }, [panel, loadNotes])

  useEffect(() => {
    if (panel !== 'search') return
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    const timer = setTimeout(() => {
      void data.search.query(q).then((res) => {
        if (res.ok) {
          setResults(res.data)
          setPanelError(null)
        } else {
          setPanelError(res.error)
        }
      })
    }, 220)
    return () => clearTimeout(timer)
  }, [query, panel])

  async function saveNote(): Promise<void> {
    if (!editing || !activeCal) return
    const payload = {
      calendarId: activeCal,
      title: editing.title,
      content: editing.content
    }
    const res = editing.id
      ? await data.notes.update(editing.id, payload)
      : await data.notes.create(payload)
    if (!res.ok) {
      setPanelError(res.error)
      return
    }
    setEditing(null)
    setPanelError(null)
    await loadNotes()
  }

  async function removeNote(id: string): Promise<void> {
    const res = await data.notes.remove(id)
    if (!res.ok) {
      setPanelError(res.error)
      return
    }
    await loadNotes()
  }

  async function jumpTo(hit: SearchHit): Promise<void> {
    if (hit.type === 'note' && hit.noteId) {
      const res = await data.notes.get(hit.noteId)
      if (!res.ok) {
        setPanelError(res.error)
        return
      }
      setActiveCal(res.data.calendarId)
      setPanel('notes')
      setEditing({ id: res.data.id, title: res.data.title, content: res.data.content })
      return
    }
    setActiveCal(hit.calendarId)
    setCursor(parseLocalDate(hit.date))
    setSelected(hit.date)
    setPanel('none')
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-drag">
          <button
            className="sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
            title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          >
            <PanelLeft />
          </button>
          <button
            className="menu-btn"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label="切换侧栏"
          >
            <Menu />
          </button>
          <span className="brand-mark">
            <CalMark size={18} />
          </span>
          <span className="brand">caldesk</span>
        </div>

        <div className="titlebar-tools">
          {offline && (
            <button
              className="net-chip"
              title="连不上服务器，点一下重试"
              onClick={() => {
                void data.sync.run().then(() => reloadAll())
              }}
            >
              <span className="net-chip-dot" />
              离线
            </button>
          )}
          <button
            className={`tool-btn ${panel === 'search' ? 'active' : ''}`}
            onClick={() => setPanel(panel === 'search' ? 'none' : 'search')}
            title="搜索"
            aria-label="搜索"
          >
            <Search />
          </button>
          <button
            className={`tool-btn ${panel === 'notes' ? 'active' : ''}`}
            onClick={() => setPanel(panel === 'notes' ? 'none' : 'notes')}
            title="便签"
            aria-label="便签"
          >
            <NoteIcon />
          </button>
          <button
            className={`tool-btn ${panel === 'settings' ? 'active' : ''}`}
            onClick={() => {
              const next = panel === 'settings' ? 'none' : 'settings'
              setPanel(next)
              if (next === 'settings') {
                // 每次打开都重新对齐真实状态：浮窗可能被它自己的关闭按钮隐藏过
                void data.settings.get().then((s) => {
                  setMiniVisible(s.miniVisible)
                  setAutoStart(s.autoStart)
                  setCloseToTray(s.closeToTray)
                })
                void data.sync.getState().then((s) => {
                  setSyncUrl(s.serverUrl)
                  setSyncDeviceName(s.deviceName)
                  setSyncAccountId(s.accountId)
                  setSyncUsername(s.username)
                  setSyncPaired(s.paired)
                })
                void loadSnaps()
              }
            }}
            aria-label="设置"
            title="设置"
          >
            <Settings />
          </button>
        </div>

        <div className="caption-buttons">
          <button
            className="caption-btn"
            onClick={() => void data.window.minimize()}
            aria-label="最小化"
          >
            <WinMinimize />
          </button>
          <button
            className="caption-btn"
            onClick={() => void data.window.toggleMaximize()}
            aria-label={maximized ? '向下还原' : '最大化'}
          >
            {maximized ? <WinRestore /> : <WinMaximize />}
          </button>
          <button
            className="caption-btn close"
            onClick={() => void data.window.close()}
            aria-label="关闭"
          >
            <WinClose />
          </button>
        </div>
      </header>

      <div className={`body ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className={`sidebar ${drawerOpen ? 'open' : ''}`}>
          <div className="month-nav">
            <button onClick={() => setCursor((c) => subMonths(c, 1))} aria-label="上个月">
              <ChevronLeft />
            </button>
            <motion.div
              className="month-label"
              key={format(cursor, 'yyyy-MM')}
              initial={{ opacity: 0, x: reduced ? 0 : 12 * monthDir.current }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: DUR.page, ease: EASE_EMPHASIZED }}
            >
              <strong>{format(cursor, 'yyyy年 M月', { locale: zhCN })}</strong>
              <span>{format(cursor, 'MMMM', { locale: zhCN })}</span>
            </motion.div>
            <button onClick={() => setCursor((c) => addMonths(c, 1))} aria-label="下个月">
              <ChevronRight />
            </button>
          </div>

          <div className="cal-list">
            {calendars.map((cal) => (
              <motion.div
                key={cal.id}
                role="button"
                tabIndex={0}
                className={`cal-item ${cal.id === activeCal ? 'active' : ''}`}
                onClick={() => {
                  setActiveCal(cal.id)
                  setDrawerOpen(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setActiveCal(cal.id)
                }}
                transition={DROPLET}
                layout
              >
                <span className="cal-dot" style={{ background: cal.color }} />
                <span className="cal-name">{cal.name}</span>
                {cal.id === activeCal && <span className="cal-current">当前</span>}
                {calendars.length > 1 && (
                  <button
                    className="cal-del"
                    title={`删除日历「${cal.name}」`}
                    aria-label={`删除日历 ${cal.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeCalendar(cal.id)
                    }}
                  >
                    <X />
                  </button>
                )}
              </motion.div>
            ))}

            {adding ? (
              <input
                className="cal-input"
                autoFocus
                value={draftName}
                maxLength={24}
                placeholder="日历名称，回车创建"
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitNew()
                  if (e.key === 'Escape') {
                    setAdding(false)
                    setDraftName('')
                  }
                }}
                onBlur={() => {
                  if (!draftName.trim()) setAdding(false)
                }}
              />
            ) : (
              <button className="cal-new" onClick={() => setAdding(true)}>
                <Plus />
                新建日历
              </button>
            )}

            {calError && <p className="cal-error">{calError}</p>}
          </div>

          <div className="sidebar-foot">
            <button
              className="ghost"
              onClick={() => {
                const now = new Date()
                setCursor(now)
                setSelected(format(now, 'yyyy-MM-dd'))
                setDrawerOpen(false)
              }}
            >
              回到今天
            </button>
          </div>
        </aside>

        {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}

        <main className="main">
          <div className="grid-head">
            {WEEKDAYS.map((d) => (
              <div key={d} className="grid-head-cell">
                {d}
              </div>
            ))}
          </div>
          <div className="grid-stage" ref={gridRef}>
            <AnimatePresence initial={false} custom={gridDir.current}>
              <motion.div
                key={gridKey}
                className="grid"
                custom={gridDir.current}
                variants={swapVariants}
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
                      onClick={() => setSelected(key)}
                      aria-pressed={key === selected}
                    >
                      <span className={`daynum ${isToday(day) ? 'today' : ''}`}>
                        {format(day, 'd')}
                      </span>
                      <div
                        className="cell-body"
                        ref={dayIndex === 0 ? cellBodyProbe : undefined}
                      >
                        {dayIndex === 0 && (
                          <span className="cell-row-probe" ref={cellRowProbe} aria-hidden="true" />
                        )}
                        {fit.ev > 0 && (
                          <div className="cell-events">
                            {dayEvents.slice(0, fit.ev).map((occ) => (
                              <span
                                key={`${occ.event.id}-${occ.date}`}
                                className={`ev ${occ.done ? 'done' : ''}`}
                              >
                                <i
                                  className="ev-dot"
                                  style={{
                                    background: occ.event.color ?? current?.color ?? 'var(--accent)'
                                  }}
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
        </main>

        <AnimatePresence>
          {selected && (
            <motion.div
              key="detail-scrim"
              className="detail-scrim"
              variants={scrimFade}
              initial="initial"
              animate="animate"
              exit="exit"
              onClick={() => setSelected(null)}
            />
          )}
          {selected && (
            <motion.aside
              key="detail"
              className="detail"
              style={{ width: `${detailWidth}px`, flex: `0 0 ${detailWidth}px` }}
              variants={panelIn(18)}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {/* 左边缘可拖动改宽度 */}
              <div className="detail-resizer" onPointerDown={startResize} />
              <div className="detail-stage">
                <AnimatePresence initial={false} custom={dayDir.current}>
                  <motion.div
                    key={selected}
                    className="detail-main"
                    custom={dayDir.current}
                    variants={swapVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <header>
                      <div>
                        <h3>{format(parseLocalDate(selected), 'M月d日 EEEE', { locale: zhCN })}</h3>
                        <p>{current?.name ?? ''}</p>
                      </div>
                      <button className="ghost" onClick={() => setSelected(null)}>
                        关闭
                      </button>
                    </header>
                    <div className="detail-body">
                      {/* 任务和事件是同一件事：任务 = 只属于这一天，事件 = 可以重复。
                          这里合成一个列表，不再分成两段。 */}
                      {selectedItems.length === 0 ? (
                        <p className="empty">这一天还没有安排</p>
                      ) : (
                        selectedItems.map((item) =>
                          item.type === 'event' ? (
                            <motion.div
                              key={`ev-${item.occ.event.id}-${item.occ.date}`}
                              layout
                              transition={DROPLET}
                              className={`task-row ${item.occ.done ? 'done' : ''}`}
                            >
                              {item.occ.event.kind === 'countdown' ? (
                                <span className="checkbox-spacer" />
                              ) : (
                                <button
                                  className={`checkbox ${item.occ.done ? 'checked' : ''}`}
                                  aria-label={item.occ.done ? '标记为未完成' : '标记为完成'}
                                  onClick={() => void toggleEventDone(item.occ)}
                                >
                                  {item.occ.done && <Check />}
                                </button>
                              )}
                              <span className="task-text">
                                <span className="task-label">{item.occ.event.title}</span>
                              </span>
                              {item.occ.event.kind === 'countdown' && (
                                <span className="ev-meta">
                                  {countdownText(item.occ.event.targetDate, item.occ.date)}
                                </span>
                              )}
                              {item.occ.event.rrule && (
                                <span className="ev-meta">{describeRrule(item.occ.event.rrule)}</span>
                              )}
                              <button
                                className="task-del"
                                aria-label="删除待办"
                                title="删除待办"
                                onClick={() => void requestRemoveEvent(item.occ)}
                              >
                                <X />
                              </button>
                            </motion.div>
                          ) : (
                            <motion.div
                              // key 用稳定身份：勾选后文案变化不重建，删除线动画才有起点
                              key={`ln-${lineText(item.text)}#${item.index}`}
                              layout
                              transition={DROPLET}
                              className={`task-row ${item.visualDone ? 'done' : ''}`}
                            >
                              <button
                                className={`checkbox ${item.visualDone ? 'checked' : ''}`}
                                aria-label={item.done ? '标记为未完成' : '标记为完成'}
                                onClick={() => toggleLine(selected, item.index, !item.done)}
                              >
                                {item.visualDone && <Check />}
                              </button>
                              <span className="task-text">
                                <span className="task-label">{lineText(item.text)}</span>
                              </span>
                              <button
                                className="task-del"
                                aria-label="删除这条待办"
                                title="删除这条待办"
                                onClick={() => void removeLine(selected, item.index)}
                              >
                                <X />
                              </button>
                            </motion.div>
                          )
                        )
                      )}
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>
              <footer>
                <div className="task-add-row">
                  <input
                    className="task-input"
                    value={draftTask}
                    maxLength={200}
                    placeholder="添加一条待办，回车保存"
                    onChange={(e) => setDraftTask(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addTask(selected)
                    }}
                  />
                  <RepeatChip
                    rule={newRepeat}
                    baseDate={selected}
                    onChange={(rule) => setNewRepeat(rule)}
                  />
                </div>

                {(cellError || eventError) && <p className="cal-error">{cellError ?? eventError}</p>}
              </footer>
            </motion.aside>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {panel !== 'none' && (
            <>
              <motion.div
                className="panel-scrim"
                variants={scrimFade}
                initial="initial"
                animate="animate"
                exit="exit"
                onClick={() => {
                  setPanel('none')
                  setEditing(null)
                }}
              />
              <motion.aside
                className="panel"
                variants={panelIn(20)}
                initial="initial"
                animate="animate"
                exit="exit"
              >
              <header className="panel-head">
                <h3>
                  {panel === 'notes' ? '便签' : panel === 'search' ? '搜索' : '设置'}
                </h3>
                <div className="panel-actions">
                  {panel === 'notes' && !editing && (
                    <button className="ghost" onClick={() => setEditing({ title: '', content: '' })}>
                      新建
                    </button>
                  )}
                  <button
                    className="ghost"
                    onClick={() => {
                      setPanel('none')
                      setEditing(null)
                    }}
                  >
                    关闭
                  </button>
                </div>
              </header>

              {panel === 'settings' && (
                <div className="panel-body set-body">
                  <section className="set-block">
                    <span className="pop-label">主题</span>
                    <div className="seg-group">
                      {THEME_ORDER.map((m) => (
                        <button
                          key={m}
                          className={`seg-item ${theme === m ? 'on' : ''}`}
                          onClick={() => {
                            setTheme(m)
                            void setThemeMode(m)
                          }}
                        >
                          {THEME_LABEL[m]}
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="set-block">
                    <span className="pop-label">启动</span>
                    <div className="pop-row">
                      <span className="pop-label-row">开机自启动</span>
                      <button
                        role="switch"
                        aria-checked={autoStart}
                        className={`switch ${autoStart ? 'on' : ''}`}
                        onClick={() => {
                          const next = !autoStart
                          setAutoStart(next)
                          void data.settings.setAutoStart(next)
                        }}
                      >
                        <span className="switch-knob" />
                      </button>
                    </div>
                    <div className="pop-row">
                      <span className="pop-label-row">关闭后进入托盘</span>
                      <button
                        role="switch"
                        aria-checked={closeToTray}
                        className={`switch ${closeToTray ? 'on' : ''}`}
                        onClick={() => {
                          const next = !closeToTray
                          setCloseToTray(next)
                          void data.settings.setCloseToTray(next)
                        }}
                      >
                        <span className="switch-knob" />
                      </button>
                    </div>
                  </section>

                  <section className="set-block">
                    <div className="pop-row">
                      <span className="pop-label-row">桌面浮窗</span>
                      <button
                        role="switch"
                        aria-checked={miniVisible}
                        className={`switch ${miniVisible ? 'on' : ''}`}
                        onClick={() => {
                          const next = !miniVisible
                          setMiniVisible(next)
                          void data.mini.setVisible(next)
                        }}
                      >
                        <span className="switch-knob" />
                      </button>
                    </div>
                  </section>

                  <section className="set-block">
                    <span className="pop-label">同步</span>

                    <div className="sync-server">
                      <input
                        className="task-input"
                        placeholder={DEFAULT_SERVER_URL || '服务器地址'}
                        value={syncUrl}
                        autoCapitalize="none"
                        autoCorrect="off"
                        onChange={(e) => setSyncUrl(e.target.value)}
                      />
                      <button className="ghost" onClick={() => void saveSyncServer()}>
                        保存
                      </button>
                    </div>

                    {syncPaired ? (
                      <div className="sync-paired">
                        <div className="pop-row">
                          <span className="pop-label-row">
                            {syncUsername || '配对账号 · 未设密码'}
                          </span>
                          <button className="ghost" onClick={() => void logoutSync()}>
                            退出登录
                          </button>
                        </div>

                        {!syncUsername && (
                          <div className="sync-create">
                            <input
                              className="task-input"
                              placeholder="用户名"
                              autoCapitalize="none"
                              value={authUser}
                              onChange={(e) => setAuthUser(e.target.value)}
                            />
                            <input
                              className="task-input"
                              type="password"
                              placeholder="密码"
                              value={authPassword}
                              onChange={(e) => setAuthPassword(e.target.value)}
                            />
                            <div className="note-actions">
                              <button className="ghost" onClick={fillStrongPassword}>
                                生成强密码
                              </button>
                              <button
                                className="primary-btn"
                                disabled={authBusy}
                                onClick={() => void claimExisting()}
                              >
                                设置账号密码
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="note-actions">
                          <button
                            className="primary-btn"
                            disabled={syncing}
                            onClick={() => void runSyncNow()}
                          >
                            {syncing ? '同步中…' : '立即同步'}
                          </button>
                        </div>

                        {deviceList.length > 0 && (
                          <div className="pair-list">
                            <div className="pop-row">
                              <span className="pop-label-row">
                                已登录设备{syncOnline > 0 ? ` · ${syncOnline} 台在线` : ''}
                              </span>
                            </div>
                            {deviceList.map((d) => (
                              <div key={d.deviceId} className="pair-row">
                                <span className="snap-label">
                                  {d.name || d.deviceId.slice(0, 8)}
                                  {d.current ? '（本机）' : ''}
                                </span>
                                {!d.current && (
                                  <button
                                    className="ghost"
                                    onClick={() => void revokeDevice(d.deviceId)}
                                    title="删除这台设备"
                                  >
                                    删除
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="sync-create">
                        <div className="seg-group">
                          <button
                            className={`seg-item ${authMode === 'login' ? 'on' : ''}`}
                            onClick={() => setAuthMode('login')}
                          >
                            登录
                          </button>
                          <button
                            className={`seg-item ${authMode === 'register' ? 'on' : ''}`}
                            onClick={() => setAuthMode('register')}
                          >
                            注册
                          </button>
                        </div>
                        <input
                          className="task-input"
                          placeholder="用户名"
                          autoCapitalize="none"
                          autoCorrect="off"
                          value={authUser}
                          onChange={(e) => setAuthUser(e.target.value)}
                        />
                        <input
                          className="task-input"
                          type="password"
                          placeholder="密码"
                          value={authPassword}
                          onChange={(e) => setAuthPassword(e.target.value)}
                        />
                        {authMode === 'register' && (
                          <input
                            className="task-input"
                            placeholder="邀请码"
                            value={authInvite}
                            onChange={(e) => setAuthInvite(e.target.value)}
                          />
                        )}
                        <div className="note-actions">
                          <button className="ghost" onClick={fillStrongPassword}>
                            生成强密码
                          </button>
                          <button
                            className="primary-btn"
                            disabled={authBusy}
                            onClick={() => void submitAuth()}
                          >
                            {authBusy ? '处理中…' : authMode === 'login' ? '登录' : '注册并登录'}
                          </button>
                        </div>
                      </div>
                    )}
                    {syncMsg && <span className="hint">{syncMsg}</span>}
                  </section>

                  <section className="set-block">
                    <div className="set-head">
                      <span className="pop-label">历史与回滚</span>
                      <span className="set-count">{snaps.length} / 100</span>
                    </div>
                    {snaps.length === 0 ? (
                      <p className="empty">还没有可回滚的记录</p>
                    ) : (
                      <>
                        {(snapExpanded ? snaps : snaps.slice(0, SNAP_PREVIEW)).map((s) => (
                          <div key={s.id} className={`snap-row ${s.current ? 'is-current' : ''}`}>
                            <div className="snap-main">
                              <span className="snap-label">
                                {s.label}
                                {s.current && <span className="snap-badge">当前</span>}
                              </span>
                              <span className="snap-meta">
                                {stampOf(s.updatedAt)} · {s.count} 处 ·{' '}
                                {s.tables.map((t) => TABLE_LABEL[t] ?? t).join('、')}
                              </span>
                            </div>
                            {!s.current && (
                              <button
                                className="ghost snap-restore"
                                onClick={() => void restoreSnap(s.id)}
                              >
                                回到这里
                              </button>
                            )}
                          </div>
                        ))}
                        {snaps.length > SNAP_PREVIEW && (
                          <button
                            className="snap-more"
                            onClick={() => setSnapExpanded((v) => !v)}
                          >
                            {snapExpanded
                              ? '收起'
                              : `展开剩余 ${snaps.length - SNAP_PREVIEW} 条`}
                          </button>
                        )}
                      </>
                    )}
                    <div className="note-actions">
                      <button className="ghost" disabled={snaps.length === 0} onClick={() => void clearSnaps()}>
                        清空记录
                      </button>
                    </div>
                    {snapMsg && <span className="hint">{snapMsg}</span>}
                  </section>
                </div>
              )}

              {panel === 'search' && (
                <>
                  <input
                    className="task-input"
                    autoFocus
                    value={query}
                    placeholder="搜索待办 / 便签"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="panel-body">
                    {results.length === 0 ? (
                      <p className="empty">{query.trim() ? '没有匹配结果' : '输入关键词开始搜索'}</p>
                    ) : (
                      results.map((hit, i) => (
                        <button
                          key={`${hit.type}-${hit.noteId ?? hit.eventId ?? i}`}
                          className="result-row"
                          onClick={() => void jumpTo(hit)}
                        >
                          <span className="ev-kind">
                            {hit.type === 'task' ? '待办' : hit.type === 'event' ? '待办' : '便签'}
                          </span>
                          <span className="result-title">{hit.title}</span>
                          <span className="ev-meta">{hit.date}</span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}

              {panel === 'notes' &&
                (editing ? (
                  <div className="note-editor">
                    <input
                      className="task-input"
                      value={editing.title}
                      placeholder="标题（可留空）"
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                    />
                    <textarea
                      className="note-text"
                      value={editing.content}
                      placeholder="内容…"
                      onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                    />
                    <div className="note-actions">
                      <button className="ghost" onClick={() => setEditing(null)}>
                        取消
                      </button>
                      <button className="primary-btn" onClick={() => void saveNote()}>
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="panel-body">
                    {notes.length === 0 ? (
                      <p className="empty">还没有便签</p>
                    ) : (
                      notes.map((n) => (
                        <div
                          key={n.id}
                          className="note-item"
                          onClick={() =>
                            setEditing({ id: n.id, title: n.title, content: n.content })
                          }
                        >
                          <div className="note-title">
                            {n.title || n.content.split('\n')[0].slice(0, 30) || '无标题'}
                          </div>
                          <div className="note-preview">{n.content.replace(/\n/g, ' ').slice(0, 80)}</div>
                          <button
                            className="task-del"
                            aria-label="删除便签"
                            title="删除便签"
                            onClick={(e) => {
                              e.stopPropagation()
                              void removeNote(n.id)
                            }}
                          >
                            <X />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                ))}

              {panelError && <p className="cal-error">{panelError}</p>}
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {confirmDelete && (
          <motion.div
            className="confirm-backdrop"
            variants={scrimFade}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={() => setConfirmDelete(null)}
          >
            <motion.div
              className="confirm-card"
              initial={{ opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{
                opacity: 0,
                scale: 0.98,
                y: 4,
                transition: { duration: DUR.fast, ease: EASE_IN }
              }}
              transition={{ duration: DUR.page, ease: EASE_EMPHASIZED }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3>删除重复待办</h3>
              <p>「{confirmDelete.event.title}」是重复待办，要删除哪一部分？</p>
              <div className="confirm-actions">
                <button className="ghost" onClick={() => setConfirmDelete(null)}>
                  取消
                </button>
                <button className="ghost" onClick={() => void skipOne()}>
                  仅删除 {confirmDelete.date.slice(5)} 这天
                </button>
                <button
                  className="primary-btn"
                  onClick={() => {
                    void removeEvent(confirmDelete.event.id)
                    setConfirmDelete(null)
                  }}
                >
                  删除整个重复
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
