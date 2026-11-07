import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { isDoneLine, lineText, splitLines } from '@shared/types'
import { CalMark, Icon } from './icons'
import { data } from './data'
import './mini.css'

interface TaskItem {
  calendarId: string
  color: string
  calendarName: string
  /** 在该视图日格中的行号，用于勾选 */
  index: number
  text: string
}

/** 当天的日程（事件 / 提醒 / 倒数日）——浮窗里只读展示，点一下回主窗口改 */
interface AgendaItem {
  calendarId: string
  color: string
  calendarName: string
  eventId: string
  date: string
  title: string
  kind: string
  done: boolean
}

function Mini(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())
  const [pinned, setPinned] = useState(true)
  const [items, setItems] = useState<TaskItem[]>([])
  const [agenda, setAgenda] = useState<AgendaItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const today = format(now, 'yyyy-MM-dd')

  const load = useCallback(async (): Promise<void> => {
    const cals = await data.calendars.list()
    if (!cals.ok) {
      setError(cals.error)
      setLoading(false)
      return
    }
    const groups = await Promise.all(
      cals.data.map(async (cal) => {
        const [cell, evs] = await Promise.all([
          data.cells.get(cal.id, today),
          data.events.range(cal.id, today, today)
        ])
        const tasks: TaskItem[] = cell.ok
          ? splitLines(cell.data.text)
              .map((line, index) => ({
                calendarId: cal.id,
                color: cal.color,
                calendarName: cal.name,
                index,
                text: line
              }))
              .filter((t) => t.text.trim().length > 0)
          : []
        const events: AgendaItem[] = evs.ok
          ? evs.data
              .filter((o) => o.date === today)
              .map((o) => ({
                calendarId: cal.id,
                color: cal.color,
                calendarName: cal.name,
                eventId: o.event.id,
                date: o.date,
                title: o.event.title,
                kind: o.event.kind,
                done: o.done
              }))
          : []
        return { tasks, events }
      })
    )
    setItems(groups.flatMap((g) => g.tasks))
    // 日程按"未完成在前、再按创建顺序"排，倒计时/提醒都算日程
    setAgenda(groups.flatMap((g) => g.events).sort((a, b) => Number(a.done) - Number(b.done)))
    setError(null)
    setLoading(false)
  }, [today])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      setNow(new Date())
      void load()
    }, 30_000)
    return () => clearInterval(timer)
  }, [load])

  // 主窗口改了数据（或自动同步拉下新数据）时立刻重读，浮窗不能显示旧内容
  useEffect(() => {
    return data.onDataChanged(() => {
      void load()
    })
  }, [load])

  // 置顶状态以主进程为准：浮窗偶尔会被重建，重建后必须跟真实设置一致
  useEffect(() => {
    void data.settings.get().then(
      (s) => setPinned(s.miniPinned),
      (err: unknown) => setError((err as Error)?.message ?? '读取设置失败')
    )
  }, [])

  async function toggle(item: TaskItem): Promise<void> {
    const done = isDoneLine(item.text)
    const res = await data.cells.setDone(item.calendarId, today, item.index, !done)
    if (!res.ok) {
      setError(res.error)
      return
    }
    const lines = splitLines(res.data.text)
    setItems((prev) =>
      prev.map((t) =>
        t.calendarId === item.calendarId && t.index === item.index
          ? { ...t, text: lines[item.index] ?? t.text }
          : t
      )
    )
  }

  /** 浮窗里直接勾选日程（重复事件按"这一次"记，单次事件记在事件本身） */
  async function toggleEvent(item: AgendaItem): Promise<void> {
    const res = await data.events.setDone(item.eventId, item.date, !item.done)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setAgenda((prev) =>
      prev.map((a) =>
        a.eventId === item.eventId && a.date === item.date ? { ...a, done: !a.done } : a
      )
    )
  }

  const pending =
    items.filter((t) => !isDoneLine(t.text)).length + agenda.filter((a) => !a.done).length
  const empty = items.length === 0 && agenda.length === 0

  return (
    <div className="mini">
      <header className="mini-head" onDoubleClick={() => void data.app.openMain()}>
        <div className="mini-title">
          <strong>
            <span className="mini-mark">
              <CalMark size={14} />
            </span>
            {format(now, 'M月d日', { locale: zhCN })}
          </strong>
          <span className="mini-sub">
            {format(now, 'EEEE', { locale: zhCN })}
            {pending > 0 ? <span className="mini-count">{pending} 项待办</span> : null}
          </span>
        </div>
        <div className="mini-actions">
          {/* drag 区域的鼠标事件会被 OS 吞掉，onDoubleClick 基本按不到 —— 主窗口入口必须是这颗按钮 */}
          <button
            className="mini-btn mini-btn-open"
            title="打开主窗口"
            aria-label="打开主窗口"
            onClick={() => void data.app.openMain()}
          >
            打开
          </button>
          <button
            className={`mini-btn ${pinned ? 'on' : ''}`}
            title={pinned ? '取消置顶' : '置顶'}
            onClick={() => {
              const next = !pinned
              setPinned(next)
              void data.mini.pin(next)
            }}
          >
            {Icon.pin}
          </button>
          <button className="mini-btn" title="隐藏" onClick={() => void data.mini.hide()}>
            {Icon.x}
          </button>
        </div>
      </header>

      <div className="mini-list">
        {loading ? (
          <p className="mini-empty">加载中…</p>
        ) : error ? (
          <p className="mini-empty">{error}</p>
        ) : empty ? (
          <p className="mini-empty">今天没有任务和日程</p>
        ) : (
          <>
            {agenda.map((a) => (
              <div
                key={`ev-${a.eventId}-${a.date}`}
                className={`mini-task-row mini-agenda ${a.done ? 'done' : ''}`}
              >
                {a.kind === 'countdown' ? (
                  <span className="mini-agenda-dot" style={{ background: a.color }} />
                ) : (
                  <button
                    className={`mini-check ${a.done ? 'checked' : ''}`}
                    aria-label={a.done ? '标记为未完成' : '标记为完成'}
                    onClick={() => void toggleEvent(a)}
                  />
                )}
                <button
                  className="mini-task-text"
                  title={`${a.calendarName} · ${
                    a.kind === 'countdown' ? '倒数日' : a.kind === 'reminder' ? '提醒' : '日程'
                  }`}
                  onClick={() => void data.app.openMain()}
                >
                  {a.title}
                </button>
                <span
                  className="mini-cal-dot"
                  style={{ background: a.color }}
                  title={a.calendarName}
                />
              </div>
            ))}
            {agenda.length > 0 && items.length > 0 && <div className="mini-sep" />}
            {items.map((item) => {
            const done = isDoneLine(item.text)
            return (
              <div
                key={`${item.calendarId}-${item.index}`}
                className={`mini-task-row ${done ? 'done' : ''}`}
              >
                <button
                  className={`mini-check ${done ? 'checked' : ''}`}
                  aria-label={done ? '标记为未完成' : '标记为完成'}
                  onClick={() => void toggle(item)}
                />
                <button
                  className="mini-task-text"
                  title={lineText(item.text)}
                  onClick={() => void data.app.openMain()}
                >
                  {lineText(item.text)}
                </button>
                <span
                  className="mini-cal-dot"
                  style={{ background: item.color }}
                  title={item.calendarName}
                />
              </div>
            )
          })}
          </>
        )}
      </div>

      <footer className="mini-foot">
        <button className="mini-open" onClick={() => void data.app.openMain()}>
          打开日历
        </button>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Mini />
  </StrictMode>
)
