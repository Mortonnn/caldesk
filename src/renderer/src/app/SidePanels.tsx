/**
 * 右侧浮层面板的外壳：遮罩 + 标题栏 + 三个面板的路由。
 *
 * 遮罩点击、右上角「关闭」都走同一个 onClose（顺带清掉便签草稿），
 * 这样 Esc 与鼠标两条路径的收尾行为一致。
 */
import { AnimatePresence, motion } from 'framer-motion'
import { panelIn, scrimFade } from '../motion'
import { NotesPanel } from './NotesPanel'
import { SearchPanel } from './SearchPanel'
import { SettingsPanel } from './SettingsPanel'
import type { PanelKind, Shell } from './useShell'
import type { NotesState } from './useNotes'
import type { Snapshots } from './useSnapshots'
import type { SyncState } from './useSyncState'

export function SidePanels(props: {
  panel: PanelKind
  onClose: () => void
  shell: Shell
  notes: NotesState
  sync: SyncState
  snaps: Snapshots
}): React.JSX.Element {
  const { panel, onClose, shell, notes, sync, snaps } = props

  return (
    <AnimatePresence>
      {panel !== 'none' && (
        <>
          <motion.div
            className="panel-scrim"
            variants={scrimFade}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
          />
          <motion.aside
            className="panel"
            variants={panelIn(20)}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <header className="panel-head">
              <h3>{panel === 'notes' ? '便签' : panel === 'search' ? '搜索' : '设置'}</h3>
              <div className="panel-actions">
                {panel === 'notes' && !notes.editing && (
                  <button
                    className="ghost"
                    onClick={() => notes.setEditing({ title: '', content: '' })}
                  >
                    新建
                  </button>
                )}
                <button className="ghost" onClick={onClose}>
                  关闭
                </button>
              </div>
            </header>

            {panel === 'settings' && <SettingsPanel shell={shell} sync={sync} snaps={snaps} />}

            {panel === 'search' && (
              <SearchPanel
                query={notes.query}
                setQuery={notes.setQuery}
                results={notes.results}
                onJump={(hit) => void notes.jumpTo(hit)}
              />
            )}

            {panel === 'notes' && (
              <NotesPanel
                notes={notes.notes}
                editing={notes.editing}
                setEditing={notes.setEditing}
                onSave={() => void notes.saveNote()}
                onRemove={(id) => void notes.removeNote(id)}
              />
            )}

            {notes.panelError && <p className="cal-error">{notes.panelError}</p>}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
