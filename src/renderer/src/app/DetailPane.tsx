/**
 * 详情栏：某一天的任务 / 事件列表 + 底部新增输入框。
 *
 * 常驻 DOM，开合走「宽度 + 淡出」的过渡 —— 和左边侧栏折叠是同一套 412ms travel 曲线。
 * 收起时不能立刻把 selected 清成 null：内容要跟着宽度一起退场，
 * 清空由 App 里那个 effect 在动画结束后做。
 */
import { AnimatePresence, motion, type Variants } from 'framer-motion'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { Check, X } from '../icons'
import { DROPLET, scrimFade } from '../motion'
import { RepeatChip } from '../RepeatChip'
import { countdownText } from '@shared/countdown'
import { describeRrule } from '@shared/rrule'
import { lineText } from '@shared/types'
import type { DetailItem } from './useDetailItems'
import { parseLocalDate } from './util'

export function DetailPane(props: {
  detailOpen: boolean
  resizing: boolean
  detailWidth: number
  startResize: (e: import('react').PointerEvent<HTMLDivElement>) => void
  selected: string | null
  /** 详情栏的换日方向 */
  dayDir: number
  variants: Variants
  items: DetailItem[]
  calendarName: string
  onClose: () => void
  onToggleEventDone: (item: Extract<DetailItem, { type: 'event' }>) => void
  onRemoveEvent: (item: Extract<DetailItem, { type: 'event' }>) => void
  onToggleLine: (date: string, index: number, done: boolean) => void
  onRemoveLine: (date: string, index: number) => void
  draftTask: string
  setDraftTask: (v: string) => void
  newRepeat: string | null
  setNewRepeat: (rule: string | null) => void
  onAddTask: (date: string) => void
  cellError: string | null
  eventError: string | null
}): React.JSX.Element {
  const {
    detailOpen,
    resizing,
    detailWidth,
    startResize,
    selected,
    dayDir,
    variants,
    items,
    calendarName,
    onClose,
    onToggleEventDone,
    onRemoveEvent,
    onToggleLine,
    onRemoveLine,
    draftTask,
    setDraftTask,
    newRepeat,
    setNewRepeat,
    onAddTask,
    cellError,
    eventError
  } = props

  return (
    <>
      <AnimatePresence>
        {detailOpen && (
          <motion.div
            key="detail-scrim"
            className="detail-scrim"
            variants={scrimFade}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
          />
        )}
      </AnimatePresence>

      <aside
        className={`detail ${detailOpen ? 'is-open' : ''} ${resizing ? 'is-resizing' : ''}`}
        style={{ '--detail-w': `${detailWidth}px` } as React.CSSProperties}
        aria-hidden={!detailOpen}
      >
        {selected && (
          <>
            {/* 左边缘可拖动改宽度 */}
            <div className="detail-resizer" onPointerDown={startResize} />
            {/* 顶栏压在滚动列表上：这里才是桌面端唯一一处"真玻璃"，blur 才有意义 */}
            <header className="detail-head">
              <div>
                <h3>{format(parseLocalDate(selected), 'M月d日 EEEE', { locale: zhCN })}</h3>
                <p>{calendarName}</p>
              </div>
              <button className="ghost" onClick={onClose}>
                关闭
              </button>
            </header>
            <div className="detail-stage">
              <AnimatePresence initial={false} custom={dayDir}>
                <motion.div
                  key={selected}
                  className="detail-main"
                  custom={dayDir}
                  variants={variants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  <div className="detail-body">
                    {/* 任务和事件是同一件事：任务 = 只属于这一天，事件 = 可以重复。
                        这里合成一个列表，不再分成两段。 */}
                    {items.length === 0 ? (
                      <p className="empty">这一天还没有安排</p>
                    ) : (
                      items.map((item) =>
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
                                onClick={() => onToggleEventDone(item)}
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
                              onClick={() => onRemoveEvent(item)}
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
                              onClick={() => onToggleLine(selected, item.index, !item.done)}
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
                              onClick={() => onRemoveLine(selected, item.index)}
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
            <footer className="detail-foot">
              <div className="task-add-row">
                <input
                  className="task-input"
                  value={draftTask}
                  maxLength={200}
                  placeholder="添加一条待办，回车保存"
                  onChange={(e) => setDraftTask(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onAddTask(selected)
                  }}
                />
                <RepeatChip rule={newRepeat} baseDate={selected} onChange={setNewRepeat} />
              </div>

              {(cellError || eventError) && <p className="cal-error">{cellError ?? eventError}</p>}
            </footer>
          </>
        )}
      </aside>
    </>
  )
}
