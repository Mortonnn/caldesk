/**
 * 「删除重复待办」确认框：仅删本次 / 删整个重复。
 *
 * 只有带 rrule 的事件才会走到这里（普通事件点了直接删）。
 */
import { AnimatePresence, motion } from 'framer-motion'
import { DUR, EASE_EMPHASIZED, EASE_IN, scrimFade } from '../motion'
import type { EventOccurrence } from '@shared/types'

export function ConfirmDelete(props: {
  target: EventOccurrence | null
  onCancel: () => void
  onSkipOne: () => void
  onRemoveAll: (id: string) => void
}): React.JSX.Element {
  const { target, onCancel, onSkipOne, onRemoveAll } = props

  return (
    <AnimatePresence>
      {target && (
        <motion.div
          className="confirm-backdrop"
          variants={scrimFade}
          initial="initial"
          animate="animate"
          exit="exit"
          onClick={onCancel}
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
            <p>「{target.event.title}」是重复待办，要删除哪一部分？</p>
            <div className="confirm-actions">
              <button className="ghost" onClick={onCancel}>
                取消
              </button>
              <button className="ghost" onClick={onSkipOne}>
                仅删除 {target.date.slice(5)} 这天
              </button>
              <button className="primary-btn" onClick={() => onRemoveAll(target.event.id)}>
                删除整个重复
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
