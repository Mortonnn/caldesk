/**
 * 详情栏的行编辑：新增待办、勾选、删除、改重复规则。
 *
 * 这一块的核心是「本地状态机 + 乐观更新」：
 *   · 勾选先在界面上播 300ms 完成动画（pendingLine），播完才写库重排
 *   · 其余写操作一律先改内存再提交，失败整体回滚
 * 所以 state 和定时器必须放在一起，拆开就会互相看不见。
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { DayCell, EventOccurrence } from '@shared/types'
import { lineText, splitLines } from '@shared/types'
import { data } from '../data'

/** setRowRepeat 的入参：文本行（日格里的一行）或事件（events 表里的一条） */
export type RowItem =
  | { type: 'line'; index: number; text: string }
  | { type: 'event'; occ: EventOccurrence }

export interface DayEdit {
  draftTask: string
  setDraftTask: Dispatch<SetStateAction<string>>
  /** 新建待办时选的重复规则；默认不重复，加完自动回到不重复 */
  newRepeat: string | null
  setNewRepeat: Dispatch<SetStateAction<string | null>>
  /** 正在播完成动画的任务行 */
  pendingLine: { index: number; done: boolean } | null
  addTask: (date: string) => Promise<void>
  toggleLine: (date: string, index: number, done: boolean) => void
  removeLine: (date: string, index: number) => Promise<void>
  setRowRepeat: (item: RowItem, rule: string | null) => Promise<void>
}

export function useDayEdit(opts: {
  activeCal: string | null
  selected: string | null
  cells: Record<string, string>
  occurrences: EventOccurrence[]
  optimisticCell: (date: string, nextText: string) => void
  applyCell: (cell: DayCell) => void
  setCellError: Dispatch<SetStateAction<string | null>>
  setEventError: Dispatch<SetStateAction<string | null>>
  setOccurrences: Dispatch<SetStateAction<EventOccurrence[]>>
}): DayEdit {
  const {
    activeCal,
    selected,
    cells,
    occurrences,
    optimisticCell,
    applyCell,
    setCellError,
    setEventError,
    setOccurrences
  } = opts

  const [draftTask, setDraftTask] = useState('')
  const [newRepeat, setNewRepeat] = useState<string | null>(null)
  /** 正在播完成动画的任务行：点上先原地播 300ms，播完才写库重排 */
  const [pendingLine, setPendingLine] = useState<{ index: number; done: boolean } | null>(null)
  const pendingLineTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (pendingLineTimer.current) clearTimeout(pendingLineTimer.current)
    },
    []
  )

  async function addTask(date: string): Promise<void> {
    const text = draftTask.trim()
    if (!text || !activeCal) return
    // 输入框右边的重复按钮选了规则：直接建一条会重复的待办（events 表，带 rrule）
    if (newRepeat) {
      const rule = newRepeat
      /*
       * 先在本地造一条临时记录画上去，再提交。
       * 以前是"等回包 → 再整块重拉"，两趟。
       */
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setOccurrences((prev) => [
        ...prev,
        {
          date,
          done: false,
          event: {
            id: tempId,
            calendarId: activeCal,
            kind: 'task',
            title: text,
            notes: null,
            allDay: true,
            start: date,
            end: null,
            rrule: rule,
            remindMinutes: null,
            targetDate: null,
            color: null,
            completed: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            deletedAt: null
          }
        }
      ])
      setDraftTask('')
      // 加完回到"不重复"，下一次默认还是普通待办
      setNewRepeat(null)
      const created = await data.events.create({
        calendarId: activeCal,
        kind: 'task',
        title: text,
        start: date,
        allDay: true,
        rrule: rule
      })
      if (!created.ok) {
        setOccurrences((prev) => prev.filter((x) => x.event.id !== tempId))
        setEventError(created.error)
        setDraftTask(text)
        setNewRepeat(rule)
        return
      }
      // 用真实记录换掉临时那条（拿到真 id，后续勾选/删除才对得上）
      setOccurrences((prev) =>
        prev.map((x) => (x.event.id === tempId ? { ...x, event: created.data } : x))
      )
      return
    }
    const base = cells[date] ?? ''
    const nextText = base.trim() ? `${base.replace(/\s+$/, '')}\n${text}` : text
    optimisticCell(date, nextText)
    setDraftTask('')
    const res = await data.cells.appendLine(activeCal, date, text)
    if (!res.ok) {
      // 回滚到提交前的样子，文字放回输入框
      optimisticCell(date, base)
      setCellError(res.error)
      setDraftTask(text)
      return
    }
    applyCell(res.data)
  }

  function toggleLine(date: string, index: number, done: boolean): void {
    if (!activeCal || pendingLine !== null) return
    setPendingLine({ index, done })
    if (pendingLineTimer.current) clearTimeout(pendingLineTimer.current)
    pendingLineTimer.current = setTimeout(() => {
      setPendingLine(null)
      void data.cells.setDone(activeCal, date, index, done).then((res) => {
        if (res.ok) applyCell(res.data)
        else setCellError(res.error)
      })
    }, 300)
  }

  async function removeLine(date: string, index: number): Promise<void> {
    if (!activeCal) return
    // 先从界面上拿掉，再去删
    const base = cells[date] ?? ''
    const rest = splitLines(base)
    rest.splice(index, 1)
    optimisticCell(date, rest.join('\n'))
    const res = await data.cells.deleteLine(activeCal, date, index)
    if (!res.ok) {
      optimisticCell(date, base)
      setCellError(res.error)
      return
    }
    applyCell(res.data)
  }

  /**
   * 改某一行的重复规则。
   *
   * 数据上「不重复的待办」是日格里的一行文本，「会重复的待办」是 events 表里
   * 一条 kind=task 的记录 —— 只有事件才带 rrule、才会在别的日期展开出现。
   * 所以这里做的是两种形态之间的搬运：
   *   - 文本行 → 选了规则：先建事件，成功后再删掉那行文本（顺序不能反，否则丢内容）
   *   - 事件行 → 选了"不重复"：删事件，把标题写回当天一行文本
   */
  async function setRowRepeat(item: RowItem, rule: string | null): Promise<void> {
    if (!activeCal || !selected) return
    const date = selected

    /*
     * 一律先改本地再提交：
     * 以前这里是"等写完 → 再整块重拉"，两趟往返。
     * 现在界面立刻变形，提交在后台跑，失败整块回滚。
     */
    const snapCells = cells
    const snapOcc = occurrences

    if (item.type === 'event') {
      const ev = item.occ.event
      if (rule) {
        setOccurrences((prev) =>
          prev.map((x) =>
            x.event.id === ev.id ? { ...x, event: { ...x.event, rrule: rule } } : x
          )
        )
        const res = await data.events.update(ev.id, { rrule: rule })
        if (!res.ok) {
          setOccurrences(snapOcc)
          setEventError(res.error)
          return
        }
        return
      }
      // 事件 → 不重复：界面上换成一行文本
      const rest = splitLines(snapCells[date] ?? '')
      optimisticCell(date, rest.length ? `${rest.join('\n')}\n${ev.title}` : ev.title)
      setOccurrences((prev) => prev.filter((x) => x.event.id !== ev.id))
      const res = await data.events.remove(ev.id)
      if (!res.ok) {
        setOccurrences(snapOcc)
        optimisticCell(date, snapCells[date] ?? '')
        setEventError(res.error)
        return
      }
      const back = await data.cells.appendLine(activeCal, date, ev.title)
      if (!back.ok) {
        setOccurrences(snapOcc)
        optimisticCell(date, snapCells[date] ?? '')
        setEventError(back.error)
      }
      return
    }

    if (!rule) return
    const title = lineText(item.text)
    if (!title) return
    // 文本行 → 会重复的待办：本地先换形态
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const rest = splitLines(snapCells[date] ?? '')
    rest.splice(item.index, 1)
    optimisticCell(date, rest.join('\n'))
    setOccurrences((prev) => [
      ...prev,
      {
        date,
        done: false,
        event: {
          id: tempId,
          calendarId: activeCal,
          kind: 'task',
          title,
          notes: null,
          allDay: true,
          start: date,
          end: null,
          rrule: rule,
          remindMinutes: null,
          targetDate: null,
          color: null,
          completed: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          deletedAt: null
        }
      }
    ])
    const created = await data.events.create({
      calendarId: activeCal,
      kind: 'task',
      title,
      start: date,
      allDay: true,
      rrule: rule
    })
    if (!created.ok) {
      setOccurrences(snapOcc)
      optimisticCell(date, snapCells[date] ?? '')
      setEventError(created.error)
      return
    }
    setOccurrences((prev) =>
      prev.map((x) => (x.event.id === tempId ? { ...x, event: created.data } : x))
    )
    const gone = await data.cells.deleteLine(activeCal, date, item.index)
    if (!gone.ok) {
      // 事件建好了但原文本行没删掉：回滚，别留两份
      setOccurrences(snapOcc)
      optimisticCell(date, snapCells[date] ?? '')
      setEventError(gone.error)
    }
  }

  return {
    draftTask,
    setDraftTask,
    newRepeat,
    setNewRepeat,
    pendingLine,
    addTask,
    toggleLine,
    removeLine,
    setRowRepeat
  }
}
