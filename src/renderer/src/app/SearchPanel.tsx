/**
 * 搜索面板：输入即搜（220ms 防抖），点结果跳到对应日期或便签。
 */
import type { SearchHit } from '@shared/types'

export function SearchPanel(props: {
  query: string
  setQuery: (v: string) => void
  results: SearchHit[]
  onJump: (hit: SearchHit) => void
}): React.JSX.Element {
  const { query, setQuery, results, onJump } = props

  return (
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
              onClick={() => onJump(hit)}
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
  )
}
