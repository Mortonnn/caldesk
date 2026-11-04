import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
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
  Trash,
  WinClose,
  WinMaximize,
  WinMinimize,
  WinRestore,
  X
} from './icons'
import { DROPLET, DUR, EASE_OUT, PANEL, fade, panelIn } from './motion'
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
  calendars: '视图',
  day_cells: '日格',
  events: '事件',
  event_done: '完成状态',
  event_skip: '跳过记录',
  notes: '便签'
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
  const [cellError, setCellError] = useState<string | null>(null)
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([])
  const [eventTitle, setEventTitle] = useState('')
  const [eventKind, setEventKind] = useState<EventKind>('task')
  const [eventRepeat, setEventRepeat] = useState<RepeatPreset>('none')
  const [eventError, setEventError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'none' | 'notes' | 'search' | 'settings'>('none')
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
    const offSync = data.sync.onDone((r) => {
      setSyncMsg(r.ok ? `同步完成：上传 ${r.pushed}，下载 ${r.pulled}` : '同步失败')
    })
    void data.calendars.list().then((res) => {
      if (!res.ok) {
        setCalError(res.error)
        return
      }
      setCalendars(res.data)
      setActiveCal((prev) => prev ?? res.data[0]?.id ?? null)
    })
    return offSync
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
    const cal = await data.calendars.list()
    if (cal.ok) {
      setCalendars(cal.data)
      setActiveCal((prev) =>
        prev && cal.data.some((c) => c.id === prev) ? prev : (cal.data[0]?.id ?? null)
      )
    }
    if (activeCal) await loadRange(activeCal)
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
  }, [])

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

  useEffect(() => {
    if (!activeCal) return
    void loadRange(activeCal)
  }, [activeCal, loadRange])

  // 浮窗（或另一处编辑）改了数据时，主窗口立刻重读当前月份，不等用户翻月
  useEffect(() => {
    return data.onDataChanged(() => {
      if (activeCal) void loadRange(activeCal)
    })
  }, [activeCal, loadRange])

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
        if (!stopped && probe.changed) {
          // 有新东西：先同步进本地库，再重读当前视图
          await data.sync.run()
          if (!stopped && activeCal) await loadRange(activeCal)
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
  }, [activeCal, loadRange])

  function applyCell(cell: DayCell): void {
    setCells((prev) => ({ ...prev, [cell.date]: cell.text }))
    setCellError(null)
  }

  async function addTask(date: string): Promise<void> {
    const text = draftTask.trim()
    if (!text || !activeCal) return
    const res = await data.cells.appendLine(activeCal, date, text)
    if (!res.ok) {
      setCellError(res.error)
      return
    }
    applyCell(res.data)
    setDraftTask('')
  }

  async function toggleLine(date: string, index: number, done: boolean): Promise<void> {
    if (!activeCal) return
    const res = await data.cells.setDone(activeCal, date, index, done)
    if (!res.ok) {
      setCellError(res.error)
      return
    }
    applyCell(res.data)
  }

  async function removeLine(date: string, index: number): Promise<void> {
    if (!activeCal) return
    const res = await data.cells.deleteLine(activeCal, date, index)
    if (!res.ok) {
      setCellError(res.error)
      return
    }
    applyCell(res.data)
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
    const res = await data.events.create({
      calendarId: activeCal,
      kind: eventKind,
      title,
      start: date,
      rrule: ruleFromPreset(eventRepeat, date),
      targetDate: eventKind === 'countdown' ? date : null,
      remindMinutes: eventKind === 'reminder' ? 0 : null
    })
    if (!res.ok) {
      setEventError(res.error)
      return
    }
    setEventTitle('')
    setEventError(null)
    await loadRange(activeCal)
  }

  async function toggleEventDone(occ: EventOccurrence): Promise<void> {
    const res = await data.events.setDone(occ.event.id, occ.date, !occ.done)
    if (!res.ok) {
      setEventError(res.error)
      return
    }
    setOccurrences((prev) =>
      prev.map((item) =>
        item.event.id === occ.event.id && item.date === occ.date
          ? { ...item, done: res.data.done }
          : item
      )
    )
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
    const res = await data.events.skip(confirmDelete.event.id, confirmDelete.date)
    if (!res.ok) {
      setEventError(res.error)
      return
    }
    setConfirmDelete(null)
    await loadRange(activeCal)
  }

  /** 重复任务先问「只删本次 / 删整个重复」 */
  async function removeEvent(id: string): Promise<void> {
    const res = await data.events.remove(id)
    if (!res.ok) {
      setEventError(res.error)
      return
    }
    if (activeCal) await loadRange(activeCal)
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
    ...selectedEvents
      .slice()
      .sort((a, b) => (a.event.createdAt ?? 0) - (b.event.createdAt ?? 0))
      .map((occ) => ({ type: 'event' as const, occ, done: occ.done })),
    ...selectedLines
      .map((text, index) => ({ type: 'line' as const, text, index, done: isDoneLine(text) }))
      .filter((l) => l.text.trim().length > 0)
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
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DUR.base, ease: EASE_OUT }}
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
                    title={`删除视图「${cal.name}」`}
                    aria-label={`删除视图 ${cal.name}`}
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
                placeholder="视图名称，回车创建"
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
                新建视图
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
          <div className="grid" ref={gridRef}>
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
                  <span className={`daynum ${isToday(day) ? 'today' : ''}`}>{format(day, 'd')}</span>
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
          </div>
        </main>

        <AnimatePresence>
          {selected && (
            <motion.div
              key="detail-scrim"
              className="detail-scrim"
              variants={fade}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: DUR.base, ease: EASE_OUT }}
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
              transition={PANEL}
            >
              {/* 左边缘可拖动改宽度 */}
              <div className="detail-resizer" onPointerDown={startResize} />
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
                  <p className="empty">这天还没有内容</p>
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
                        <span className="task-text">{item.occ.event.title}</span>
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
                          aria-label="删除事件"
                          title="删除事件"
                          onClick={() => void requestRemoveEvent(item.occ)}
                        >
                          <Trash />
                        </button>
                      </motion.div>
                    ) : (
                      <motion.div
                        key={`ln-${item.index}-${item.text}`}
                        layout
                        transition={DROPLET}
                        className={`task-row ${item.done ? 'done' : ''}`}
                      >
                        <button
                          className={`checkbox ${item.done ? 'checked' : ''}`}
                          aria-label={item.done ? '标记为未完成' : '标记为完成'}
                          onClick={() => void toggleLine(selected, item.index, !item.done)}
                        >
                          {item.done && <Check />}
                        </button>
                        <span className="task-text">{lineText(item.text)}</span>
                        <button
                          className="task-del"
                          aria-label="删除这条任务"
                          title="删除这条任务"
                          onClick={() => void removeLine(selected, item.index)}
                        >
                          <Trash />
                        </button>
                      </motion.div>
                    )
                  )
                )}
              </div>
              <footer>
                <input
                  className="task-input"
                  value={draftTask}
                  maxLength={200}
                  placeholder="添加一条任务，回车保存"
                  onChange={(e) => setDraftTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addTask(selected)
                  }}
                />

                {/* 事件 = 可以重复的任务。默认折叠：日常只用当天任务输入框 */}
                <button
                  className={`event-toggle ${eventOpen ? 'open' : ''}`}
                  onClick={() => setEventOpen((v) => !v)}
                  aria-expanded={eventOpen}
                >
                  <span className="event-toggle-chev">
                    <ChevronRight />
                  </span>
                  {eventOpen ? '收起事件选项' : '展开事件选项'}
                </button>

                <AnimatePresence initial={false}>
                  {eventOpen && (
                    <motion.div
                      className="event-add"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <input
                        className="task-input"
                        value={eventTitle}
                        maxLength={200}
                        placeholder="事件标题，回车保存"
                        onChange={(e) => setEventTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void addEvent(selected)
                        }}
                      />
                      <div className="event-opts">
                        <select
                          className="mini-select"
                          value={eventRepeat}
                          disabled={eventKind === 'countdown'}
                          title={eventKind === 'countdown' ? '倒数日不支持重复' : '重复规则'}
                          onChange={(e) => setEventRepeat(e.target.value as RepeatPreset)}
                        >
                          {(Object.keys(REPEAT_LABEL) as RepeatPreset[]).map((k) => (
                            <option key={k} value={k}>
                              {REPEAT_LABEL[k]}
                            </option>
                          ))}
                        </select>
                        <select
                          className="mini-select"
                          value={eventKind}
                          onChange={(e) => {
                            const next = e.target.value as EventKind
                            setEventKind(next)
                            if (next === 'countdown') setEventRepeat('none')
                          }}
                        >
                          <option value="task">任务</option>
                          <option value="reminder">提醒</option>
                          <option value="countdown">倒数日</option>
                        </select>
                      </div>
                      {eventRepeat === 'custom' && (
                        <div className="custom-repeat">
                          <span className="custom-repeat-label">每</span>
                          <input
                            className="task-input custom-repeat-input"
                            type="number"
                            min={1}
                            max={365}
                            value={customDays}
                            onChange={(e) => setCustomDays(Number(e.target.value) || 1)}
                          />
                          <span className="custom-repeat-label">天重复一次</span>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

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
                variants={fade}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={{ duration: DUR.base, ease: EASE_OUT }}
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
                transition={PANEL}
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
                      <div>
                        <span className="pop-label-row">开机自启动</span>
                        <p className="pop-desc">登录 Windows 后自动启动到托盘，不弹主窗口</p>
                      </div>
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
                      <div>
                        <span className="pop-label-row">关闭后进入托盘</span>
                        <p className="pop-desc">
                          {closeToTray
                            ? '收进托盘继续后台同步，从托盘菜单退出'
                            : '直接退出程序，后台不再同步'}
                        </p>
                      </div>
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
                      <div>
                        <span className="pop-label-row">桌面浮窗</span>
                        <p className="pop-desc">常驻右下角的任务浮窗，不开主窗口也能用</p>
                      </div>
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
                        placeholder={
                          DEFAULT_SERVER_URL
                            ? `服务器地址（留空 = ${DEFAULT_SERVER_URL}）`
                            : '服务器地址，例如 https://caldesk.workers.dev'
                        }
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
                          <div>
                            <span className="pop-label-row">{syncUsername || '已登录'}</span>
                            <p className="pop-desc">
                              {syncUsername
                                ? '其他设备用同一个账号登录，读写同一份日历'
                                : '这个账号还没有用户名密码'}
                            </p>
                          </div>
                          <button className="ghost" onClick={() => void logoutSync()}>
                            退出登录
                          </button>
                        </div>

                        {!syncUsername && (
                          <div className="sync-create">
                            <p className="pop-desc">
                              这是配对时代创建的账号：设置一组用户名密码，手机或另一台电脑就能直接登录。
                            </p>
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
                              placeholder="密码（至少 10 位，含大小写、数字、符号）"
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
                                    title="撤销这台设备的凭据并从列表删除"
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
                          placeholder="密码（至少 10 位，含大小写、数字、符号）"
                          value={authPassword}
                          onChange={(e) => setAuthPassword(e.target.value)}
                        />
                        {authMode === 'register' && (
                          <input
                            className="task-input"
                            placeholder="邀请码（服务器设置了才需要）"
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
                        <p className="pop-desc">
                          同一账号在任意设备登录，都读写同一份日历；换设备不需要配对。
                        </p>
                      </div>
                    )}
                    {syncMsg && <span className="hint">{syncMsg}</span>}
                  </section>

                  <section className="set-block">
                    <div className="set-head">
                      <span className="pop-label">历史与回滚</span>
                      <span className="set-count">{snaps.length} / 100</span>
                    </div>
                    <p className="pop-desc">
                      每次改动记一个时间点；点哪个点就回到哪个点，不新增记录。
                    </p>
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
                    placeholder="搜索任务 / 事件 / 便签"
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
                            {hit.type === 'task' ? '任务' : hit.type === 'event' ? '事件' : '便签'}
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
                            <Trash />
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
            variants={fade}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={{ duration: DUR.base, ease: EASE_OUT }}
            onClick={() => setConfirmDelete(null)}
          >
            <motion.div
              className="confirm-card"
              initial={{ opacity: 0, scale: 0.97, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={PANEL}
              onClick={(e) => e.stopPropagation()}
            >
              <h3>删除重复任务</h3>
              <p>「{confirmDelete.event.title}」是重复任务，要删除哪一部分？</p>
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
