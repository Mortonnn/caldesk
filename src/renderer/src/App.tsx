/**
 * 桌面端主界面：只留四个顶层状态 + 布局骨架 + 组装。
 *
 * 拆分原则是**按状态归属**，不是按界面块：
 *   · 数据和写操作 → app/use*.ts（各自持有自己的 state 与 effect）
 *   · 纯展示 → app/*.tsx（只吃 props，不持有状态）
 * 这样任何一次 setState 只会重跑真正相关的那个 hook 和它下面的子树，
 * 而不是像以前那样把 1965 行的函数体整个重跑一遍。
 *
 * 四个顶层状态：calendars / activeCal / cursor / selected。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, useReducedMotion, type Variants } from 'framer-motion'
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek, subMonths } from 'date-fns'
import type { CalendarMeta } from '@shared/types'
import { fade } from './motion'
import { Ambient } from './ui/Glass'
import { data } from './data'
import { Titlebar } from './app/Titlebar'
import { Sidebar } from './app/Sidebar'
import { MonthGrid } from './app/MonthGrid'
import { DetailPane } from './app/DetailPane'
import { SidePanels } from './app/SidePanels'
import { ConfirmDelete } from './app/ConfirmDelete'
import { useShell } from './app/useShell'
import { useMonthData } from './app/useMonthData'
import { useDayEdit } from './app/useDayEdit'
import { useDetailItems } from './app/useDetailItems'
import { useNotes } from './app/useNotes'
import { useSyncState } from './app/useSyncState'
import { useSnapshots } from './app/useSnapshots'
import { WEEKDAYS, parseLocalDate, read, sheetSwap } from './app/util'

export default function App(): React.JSX.Element {
  /* --------------------------- 四个顶层状态 --------------------------- */
  const [cursor, setCursor] = useState(() => new Date())
  const [calendars, setCalendars] = useState<CalendarMeta[]>([])
  const [activeCal, setActiveCal] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(format(new Date(), 'yyyy-MM-dd'))

  /* 侧栏新建视图的草稿 + 错误槽（提交后要切到新视图，所以留在顶层） */
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [calError, setCalError] = useState<string | null>(null)

  /** 详情栏是否展开：和"选中哪天"分开，收起才能是一段宽度动画而不是瞬间卸载 */
  const [detailOpen, setDetailOpen] = useState(true)

  /* ------------------------------- 壳 ------------------------------- */
  const shell = useShell()
  const { panel, setPanel, drawerOpen, setDrawerOpen } = shell

  /*
   * 换页方向由**事件处理函数**显式给出，不在渲染期改 ref。
   * 渲染期改 ref 在并发渲染下会执行两次，方向会抖一下。
   */
  const monthDir = useRef(1)
  const dayDir = useRef(1)
  const gridDir = useRef(1)

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 })
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 })
    return eachDayOfInterval({ start, end })
  }, [cursor])

  const monthRange = useMemo(
    () => ({
      from: format(days[0], 'yyyy-MM-dd'),
      to: format(days[days.length - 1], 'yyyy-MM-dd')
    }),
    [days]
  )

  /* ----------------------------- 数据钩子 ----------------------------- */
  const month = useMonthData({
    activeCal,
    monthRange,
    setCalendars,
    setActiveCal,
    setCalError
  })

  const dayEdit = useDayEdit({
    activeCal,
    selected,
    cells: month.cells,
    occurrences: month.occurrences,
    optimisticCell: month.optimisticCell,
    applyCell: month.applyCell,
    setCellError: month.setCellError,
    setEventError: month.setEventError,
    setOccurrences: month.setOccurrences
  })

  const detail = useDetailItems({
    activeCal,
    selected,
    cells: month.cells,
    occurrences: month.occurrences,
    eventsByDate: month.eventsByDate,
    pendingLine: dayEdit.pendingLine,
    setOccurrences: month.setOccurrences,
    setEventError: month.setEventError
  })

  const sync = useSyncState({ reloadAll: month.reloadAll })
  const snaps = useSnapshots({ reloadAll: month.reloadAll })

  const notes = useNotes({
    activeCal,
    panel,
    setPanel,
    setActiveCal,
    openDate: (calendarId, date) => {
      setActiveCal(calendarId)
      gridDir.current = 1
      setCursor(parseLocalDate(date))
      selectDay(date)
      setDetailOpen(true)
      setPanel('none')
    }
  })

  /* ------------------------------ 交互 ------------------------------ */

  /** 翻月：方向在这里定，网格与侧栏标题共用 */
  function goMonth(delta: number): void {
    monthDir.current = delta
    gridDir.current = delta
    setCursor((c) => (delta > 0 ? addMonths(c, 1) : subMonths(c, 1)))
  }

  /** 换日历：横向进入，不跟月份方向混在一起 */
  function selectCalendar(id: string): void {
    gridDir.current = 1
    setActiveCal(id)
  }

  /** 选日期：详情栏的换日方向 */
  function selectDay(key: string | null): void {
    if (key === null) {
      // 只关面板，不清 selected —— 内容要跟着宽度一起退场（由下面的 effect 收尾）
      setDetailOpen(false)
      return
    }
    dayDir.current = key > (selected ?? '') ? 1 : -1
    setSelected(key)
    setDetailOpen(true)
  }

  function openToday(): void {
    const now = new Date()
    gridDir.current = 1
    setCursor(now)
    selectDay(format(now, 'yyyy-MM-dd'))
    setDrawerOpen(false)
  }

  /** 搜索 / 便签按钮：同一个面板再点一次就关掉 */
  function togglePanel(p: 'notes' | 'search'): void {
    setPanel(panel === p ? 'none' : p)
  }

  function closePanel(): void {
    setPanel('none')
    notes.setEditing(null)
  }

  /** 设置按钮：每打开一次都把壳里的真值重新对齐（浮窗可能被它自己的关闭按钮隐藏过） */
  function openSettings(): void {
    const next = panel === 'settings' ? 'none' : 'settings'
    setPanel(next)
    if (next === 'settings') {
      shell.refreshSettings()
      sync.reloadState()
      void snaps.loadSnaps()
    }
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

  /* ------------------------------ effect ------------------------------ */

  // 视图列表读不到时必须有可见提示：否则用户看到的是"侧栏空着，什么也没发生"
  useEffect(() => {
    read(
      data.calendars.list(),
      (res) => {
        if (!res.ok) {
          setCalError(res.error)
          return
        }
        setCalendars(res.data)
        setActiveCal((prev) => prev ?? res.data[0]?.id ?? null)
      },
      (err) => setCalError(`读取视图失败：${err.message}`)
    )
  }, [])

  /*
   * 收起动画跑完再清 selected。
   * 清早了列表会先变空，屏幕上只剩一条空纸在缩，很怪。
   * 440ms = --t-travel 412ms + 一点余量。
   */
  useEffect(() => {
    if (detailOpen) return
    const timer = setTimeout(() => setSelected(null), 440)
    return () => clearTimeout(timer)
  }, [detailOpen])

  /*
   * Esc 关掉最上面那一层：确认框 → 侧面板 → 详情栏 → 抽屉。
   * 以前只有"新建日历"那个输入框认 Esc，弹层一律只能点按钮，键盘用户没法退。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (detail.confirmDelete) detail.setConfirmDelete(null)
      else if (panel !== 'none') closePanel()
      else if (drawerOpen) setDrawerOpen(false)
      else if (selected) selectDay(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.confirmDelete, panel, drawerOpen, selected])

  /*
   * ← / → 翻月。
   *
   * 42 个格子都是 <button>，键盘用户只能靠 Tab 一格一格挪、翻月只能去点那两个
   * 没有文字的箭头；日历这种"整月一张表"的控件，左右翻月是默认预期。
   *
   * 三条边界：
   *   · 焦点在输入框 / 文本域里时不管 —— 在待办输入框里按 ← 是要移光标的；
   *   · 侧面板 / 确认框打开时不管 —— 那一层有它自己的焦点语义；
   *   · 带修饰键时不管 —— Ctrl+← 之类留给系统。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      if (panel !== 'none' || detail.confirmDelete) return
      e.preventDefault()
      goMonth(e.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, detail.confirmDelete])

  /* 系统要求减少动态时换页只淡入淡出，不留位移 */
  const reduced = useReducedMotion()
  const swapVariants: Variants = reduced ? fade : sheetSwap

  const current = calendars.find((c) => c.id === activeCal) ?? calendars[0]
  /** 换页键：视图或月份变一次换一张；同月内增删任务不换，免得整片闪一下 */
  const gridKey = `${activeCal}|${format(cursor, 'yyyy-MM')}`

  return (
    <div
      className={`app ${shell.maximized ? 'is-max' : ''} ${
        detail.confirmDelete || panel !== 'none' ? 'is-blurred' : ''
      }`}
    >
      <Ambient />

      <Titlebar
        maximized={shell.maximized}
        sidebarCollapsed={shell.sidebarCollapsed}
        onToggleSidebar={shell.toggleSidebar}
        onToggleDrawer={() => setDrawerOpen(!drawerOpen)}
        panel={panel}
        onTogglePanel={togglePanel}
        onOpenSettings={openSettings}
        offline={sync.offline}
        onRetry={() => {
          void data.sync.run().then(() => month.reloadAll())
        }}
      />

      <div className={`body ${shell.sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <Sidebar
          drawerOpen={drawerOpen}
          cursor={cursor}
          monthDir={monthDir.current}
          reduced={reduced}
          onMonth={goMonth}
          calendars={calendars}
          activeCal={activeCal}
          onSelectCalendar={(id) => {
            selectCalendar(id)
            setDrawerOpen(false)
          }}
          onRemoveCalendar={(id) => void removeCalendar(id)}
          adding={adding}
          setAdding={setAdding}
          draftName={draftName}
          setDraftName={setDraftName}
          onSubmitNew={() => void submitNew()}
          calError={calError}
          onToday={openToday}
        />

        {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} />}

        <main className="main">
          <div className="grid-head">
            {WEEKDAYS.map((d) => (
              <div key={d} className="grid-head-cell">
                {d}
              </div>
            ))}
          </div>
          <MonthGrid
            activeCal={activeCal}
            gridKey={gridKey}
            gridDir={gridDir.current}
            variants={swapVariants}
            days={days}
            cursor={cursor}
            cells={month.cells}
            eventsByDate={month.eventsByDate}
            selected={selected}
            accent={current?.color}
            onSelectDay={selectDay}
          />
        </main>

        <DetailPane
          detailOpen={detailOpen}
          resizing={shell.resizing}
          detailWidth={shell.detailWidth}
          startResize={shell.startResize}
          selected={selected}
          dayDir={dayDir.current}
          variants={swapVariants}
          items={detail.selectedItems}
          calendarName={current?.name ?? ''}
          onClose={() => selectDay(null)}
          onToggleEventDone={(item) => void detail.toggleEventDone(item.occ)}
          onRemoveEvent={(item) => void detail.requestRemoveEvent(item.occ)}
          onToggleLine={dayEdit.toggleLine}
          onRemoveLine={(date, index) => void dayEdit.removeLine(date, index)}
          draftTask={dayEdit.draftTask}
          setDraftTask={dayEdit.setDraftTask}
          newRepeat={dayEdit.newRepeat}
          setNewRepeat={dayEdit.setNewRepeat}
          onAddTask={(date) => void dayEdit.addTask(date)}
          cellError={month.cellError}
          eventError={month.eventError}
        />

        <SidePanels
          panel={panel}
          onClose={closePanel}
          shell={shell}
          notes={notes}
          sync={sync}
          snaps={snaps}
        />
      </div>

      <ConfirmDelete
        target={detail.confirmDelete}
        onCancel={() => detail.setConfirmDelete(null)}
        onSkipOne={() => void detail.skipOne()}
        onRemoveAll={(id) => {
          void detail.removeEvent(id)
          detail.setConfirmDelete(null)
        }}
      />
    </div>
  )
}
