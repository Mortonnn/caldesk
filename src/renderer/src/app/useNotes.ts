/**
 * 便签面板 + 搜索面板的数据。
 *
 * 两块放一起是因为它们共享同一个错误槽（panelError）和同一段
 * 「点搜索结果 → 跳到某天 / 打开某条便签」的收尾逻辑。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { Note, SearchHit } from '@shared/types'
import { data } from '../data'
import { read } from './util'
import type { PanelKind } from './useShell'

export interface NotesState {
  notes: Note[]
  editing: { id?: string; title: string; content: string } | null
  setEditing: Dispatch<SetStateAction<{ id?: string; title: string; content: string } | null>>
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  results: SearchHit[]
  panelError: string | null
  setPanelError: Dispatch<SetStateAction<string | null>>
  loadNotes: () => Promise<void>
  saveNote: () => Promise<void>
  removeNote: (id: string) => Promise<void>
  jumpTo: (hit: SearchHit) => Promise<void>
}

export function useNotes(opts: {
  activeCal: string | null
  panel: PanelKind
  setPanel: (p: PanelKind) => void
  setActiveCal: Dispatch<SetStateAction<string | null>>
  /** 跳到某天并展开详情栏（gridDir / cursor / selected 的收尾留在 App 里） */
  openDate: (calendarId: string, date: string) => void
}): NotesState {
  const { activeCal, panel, setPanel, setActiveCal, openDate } = opts

  const [notes, setNotes] = useState<Note[]>([])
  const [editing, setEditing] = useState<{ id?: string; title: string; content: string } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [panelError, setPanelError] = useState<string | null>(null)

  const loadNotes = useCallback(async (): Promise<void> => {
    try {
      const res = await data.notes.list(activeCal ?? undefined)
      if (res.ok) {
        setNotes(res.data)
        setPanelError(null)
      } else {
        setPanelError(res.error)
      }
    } catch (err) {
      setPanelError(`读取便签失败：${(err as Error).message}`)
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
      read(
        data.search.query(q),
        (res) => {
          if (res.ok) {
            setResults(res.data)
            setPanelError(null)
          } else {
            setPanelError(res.error)
          }
        },
        (err) => setPanelError(`搜索失败：${err.message}`)
      )
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
    openDate(hit.calendarId, hit.date)
  }

  return {
    notes,
    editing,
    setEditing,
    query,
    setQuery,
    results,
    panelError,
    setPanelError,
    loadNotes,
    saveNote,
    removeNote,
    jumpTo
  }
}
