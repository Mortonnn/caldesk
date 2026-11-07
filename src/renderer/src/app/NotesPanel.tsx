/**
 * 便签面板：列表 / 编辑器两态。
 *
 * 编辑器的草稿（editing）放在 useNotes 里，因为「点搜索结果直接打开某条便签」
 * 也要写同一个 state。这里只负责画。
 */
import { X } from '../icons'
import type { Note } from '@shared/types'

export function NotesPanel(props: {
  notes: Note[]
  editing: { id?: string; title: string; content: string } | null
  setEditing: (v: { id?: string; title: string; content: string } | null) => void
  onSave: () => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const { notes, editing, setEditing, onSave, onRemove } = props

  if (editing) {
    return (
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
          <button className="primary-btn" onClick={onSave}>
            保存
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="panel-body">
      {notes.length === 0 ? (
        <p className="empty">还没有便签</p>
      ) : (
        notes.map((n) => (
          <div
            key={n.id}
            className="note-item"
            onClick={() => setEditing({ id: n.id, title: n.title, content: n.content })}
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
                onRemove(n.id)
              }}
            >
              <X />
            </button>
          </div>
        ))
      )}
    </div>
  )
}
