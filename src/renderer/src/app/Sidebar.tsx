/**
 * 左侧栏：月份标题 + 视图列表 + 回到今天。
 *
 * 只吃 props。新建视图的输入框状态（adding / draftName）留在 App 里，
 * 因为「回车创建 → 选中新视图」的收尾要碰 activeCal。
 */
import { motion } from 'framer-motion'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { ChevronLeft, ChevronRight, Plus, X } from '../icons'
import { DROPLET, DUR, EASE_EMPHASIZED } from '../motion'
import type { CalendarMeta } from '@shared/types'

export function Sidebar(props: {
  drawerOpen: boolean
  cursor: Date
  /** 翻月方向（由 goMonth 在事件处理里写入） */
  monthDir: number
  /** 系统是否要求减少动态（framer 的 useReducedMotion 可能给 null） */
  reduced: boolean | null
  onMonth: (delta: number) => void
  calendars: CalendarMeta[]
  activeCal: string | null
  onSelectCalendar: (id: string) => void
  onRemoveCalendar: (id: string) => void
  adding: boolean
  setAdding: (v: boolean) => void
  draftName: string
  setDraftName: (v: string) => void
  onSubmitNew: () => void
  calError: string | null
  onToday: () => void
}): React.JSX.Element {
  const {
    drawerOpen,
    cursor,
    monthDir,
    reduced,
    onMonth,
    calendars,
    activeCal,
    onSelectCalendar,
    onRemoveCalendar,
    adding,
    setAdding,
    draftName,
    setDraftName,
    onSubmitNew,
    calError,
    onToday
  } = props

  return (
    <aside className={`sidebar ${drawerOpen ? 'open' : ''}`}>
      <div className="month-nav">
        <button onClick={() => onMonth(-1)} aria-label="上个月">
          <ChevronLeft />
        </button>
        <motion.div
          className="month-label"
          key={format(cursor, 'yyyy-MM')}
          initial={{ opacity: 0, x: reduced ? 0 : 12 * monthDir }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: DUR.page, ease: EASE_EMPHASIZED }}
        >
          <strong>{format(cursor, 'M月')}</strong>
          <span>{format(cursor, 'yyyy年 · MMMM', { locale: zhCN })}</span>
        </motion.div>
        <button onClick={() => onMonth(1)} aria-label="下个月">
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
            onClick={() => onSelectCalendar(cal.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelectCalendar(cal.id)
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
                  onRemoveCalendar(cal.id)
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
              if (e.key === 'Enter') onSubmitNew()
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
        <button className="ghost" onClick={onToday}>
          回到今天
        </button>
      </div>
    </aside>
  )
}
