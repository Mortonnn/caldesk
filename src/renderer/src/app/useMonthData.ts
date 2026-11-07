/**
 * 当月数据：日格（cells）+ 事件（occurrences）的加载、乐观更新与失效重读。
 *
 * 这里是整个界面最容易被竞态咬到的一块，所以把守卫和它的说明一起搬过来：
 *   · loadSeq —— 只认最新一次请求的回包（翻月 / 换视图时会有多份回包同时在飞）
 *   · activeCalRef —— 让 reloadAll 保持稳定，data:changed 订阅不必随状态重建
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { CalendarMeta, DayCell, EventOccurrence } from '@shared/types'
import { data } from '../data'

export interface MonthRange {
  from: string
  to: string
}

export interface MonthData {
  cells: Record<string, string>
  setCells: Dispatch<SetStateAction<Record<string, string>>>
  occurrences: EventOccurrence[]
  setOccurrences: Dispatch<SetStateAction<EventOccurrence[]>>
  eventsByDate: Record<string, EventOccurrence[]>
  cellError: string | null
  eventError: string | null
  setCellError: Dispatch<SetStateAction<string | null>>
  setEventError: Dispatch<SetStateAction<string | null>>
  applyCell: (cell: DayCell) => void
  optimisticCell: (date: string, nextText: string) => void
  reloadAll: () => Promise<void>
}

export function useMonthData(opts: {
  activeCal: string | null
  monthRange: MonthRange
  setCalendars: Dispatch<SetStateAction<CalendarMeta[]>>
  setActiveCal: Dispatch<SetStateAction<string | null>>
  setCalError: Dispatch<SetStateAction<string | null>>
}): MonthData {
  const { activeCal, monthRange, setCalendars, setActiveCal, setCalError } = opts

  const [cells, setCells] = useState<Record<string, string>>({})
  const [cellError, setCellError] = useState<string | null>(null)
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([])
  const [eventError, setEventError] = useState<string | null>(null)

  /*
   * 加载序号。
   *
   * 翻月 / 换视图时会有多份回包同时在飞：桌面端读的是本地 SQLite，本来就快，
   * 但一次同步、一次副屏重绘、或者主进程正好在处理别的 IPC，都能让**先发的后回**。
   * 以前谁最后落地谁生效 —— 迟到的上个月回包会把当前月的日格整张覆盖掉，
   * 表现就是"翻过去那一页是空的，再翻回来又有了"。
   * 现在只认最新一份：序号对不上就直接丢弃。
   */
  const loadSeq = useRef(0)

  // 切换视图或翻月时重新加载日格与事件
  const loadRange = useCallback(
    async (calendarId: string): Promise<void> => {
      const seq = (loadSeq.current += 1)
      const [cellsRes, eventsRes] = await Promise.all([
        data.cells.range(calendarId, monthRange.from, monthRange.to),
        data.events.range(calendarId, monthRange.from, monthRange.to)
      ])
      // 已经有人发过更新的请求：这份回包过期了，丢掉（别覆盖新月份）
      if (seq !== loadSeq.current) return
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
    let res: Awaited<ReturnType<typeof data.calendars.list>>
    try {
      res = await data.calendars.list()
    } catch (err) {
      // IPC 本身炸了：留着旧列表接着用，但必须让人看见
      setCalError(`刷新失败：${(err as Error).message}`)
      const cur = activeCalRef.current
      if (cur) await loadRange(cur)
      return
    }
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
  }, [loadRange, setActiveCal, setCalendars, setCalError])

  useEffect(() => {
    if (!activeCal) return
    void loadRange(activeCal)
  }, [activeCal, loadRange])

  // 浮窗、另一处编辑、或者一次同步带回了新数据：整块重读，别只翻日格
  useEffect(() => {
    return data.onDataChanged(() => void reloadAll())
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

  const eventsByDate = useMemo(() => {
    const map: Record<string, EventOccurrence[]> = {}
    for (const occ of occurrences) {
      ;(map[occ.date] ??= []).push(occ)
    }
    return map
  }, [occurrences])

  return {
    cells,
    setCells,
    occurrences,
    setOccurrences,
    eventsByDate,
    cellError,
    eventError,
    setCellError,
    setEventError,
    applyCell,
    optimisticCell,
    reloadAll
  }
}
