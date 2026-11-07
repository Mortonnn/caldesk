/**
 * 详情栏的列表内容 + 事件行的写操作。
 *
 * 「任务」和「事件」在用户眼里是同一件事：任务只属于这一天，事件可以重复。
 * 所以两者在这里合流成一个列表（selectedItems），排序规则也写在这：
 * 未完成在上、已完成在下；组内保持创建顺序。
 */
import { useState, type Dispatch, type SetStateAction } from 'react'
import type { EventOccurrence } from '@shared/types'
import { isDoneLine, splitLines } from '@shared/types'
import { data } from '../data'

/** 详情栏里的一行：日格文本行，或事件的一次发生 */
export type DetailItem =
  | { type: 'line'; text: string; index: number; done: boolean; visualDone: boolean }
  | { type: 'event'; occ: EventOccurrence; done: boolean; visualDone: boolean }

export interface DetailItems {
  selectedItems: DetailItem[]
  confirmDelete: EventOccurrence | null
  setConfirmDelete: Dispatch<SetStateAction<EventOccurrence | null>>
  toggleEventDone: (occ: EventOccurrence) => Promise<void>
  requestRemoveEvent: (occ: EventOccurrence) => Promise<void>
  removeEvent: (id: string) => Promise<void>
  skipOne: () => Promise<void>
}

export function useDetailItems(opts: {
  activeCal: string | null
  selected: string | null
  cells: Record<string, string>
  occurrences: EventOccurrence[]
  eventsByDate: Record<string, EventOccurrence[]>
  pendingLine: { index: number; done: boolean } | null
  setOccurrences: Dispatch<SetStateAction<EventOccurrence[]>>
  setEventError: Dispatch<SetStateAction<string | null>>
}): DetailItems {
  const {
    activeCal,
    selected,
    cells,
    occurrences,
    eventsByDate,
    pendingLine,
    setOccurrences,
    setEventError
  } = opts

  const [confirmDelete, setConfirmDelete] = useState<EventOccurrence | null>(null)

  async function toggleEventDone(occ: EventOccurrence): Promise<void> {
    // 先亮状态，提交在后台跑
    const next = !occ.done
    setOccurrences((prev) =>
      prev.map((item) =>
        item.event.id === occ.event.id && item.date === occ.date ? { ...item, done: next } : item
      )
    )
    const res = await data.events.setDone(occ.event.id, occ.date, next)
    if (!res.ok) {
      setOccurrences((prev) =>
        prev.map((item) =>
          item.event.id === occ.event.id && item.date === occ.date
            ? { ...item, done: occ.done }
            : item
        )
      )
      setEventError(res.error)
    }
  }

  /** 重复任务先问「只删本次 / 删整个重复」 */
  async function requestRemoveEvent(occ: EventOccurrence): Promise<void> {
    if (!occ.event.rrule) {
      await removeEvent(occ.event.id)
      return
    }
    setConfirmDelete(occ)
  }

  async function skipOne(): Promise<void> {
    if (!confirmDelete || !activeCal) return
    /*
     * 「仅删本次」在数据上是往 event_skip 里插一条，
     * 列表时这一天的实例就被滤掉了 —— 所以界面上要把这一行整个拿掉，
     * 不是标成完成。
     */
    const target = confirmDelete
    const snapOcc = occurrences
    setOccurrences((prev) =>
      prev.filter((x) => !(x.event.id === target.event.id && x.date === target.date))
    )
    setConfirmDelete(null)
    const res = await data.events.skip(target.event.id, target.date)
    if (!res.ok) {
      setOccurrences(snapOcc)
      setEventError(res.error)
    }
  }

  async function removeEvent(id: string): Promise<void> {
    // 先从界面上拿掉
    const snapOcc = occurrences
    setOccurrences((prev) => prev.filter((x) => x.event.id !== id))
    const res = await data.events.remove(id)
    if (!res.ok) {
      setOccurrences(snapOcc)
      setEventError(res.error)
      return
    }
  }

  /* 倒数日文案（今天 / 还有 N 天 / 已过 N 天）的规则只有一份实现，见 @shared/countdown */

  const selectedEvents = selected ? (eventsByDate[selected] ?? []) : []
  const selectedLines = selected ? splitLines(cells[selected] ?? '') : []

  /**
   * 任务和事件合并成一个列表。
   *
   * 用户视角它们是同一件事：都是"某天要做的事"，
   * 区别只是任务只属于这一天，事件可以重复。
   *
   * 排序：未完成在上、已完成在下；组内保持创建顺序
   * （事件按 createdAt，任务行按行号；稳定排序不会打乱组内次序）。
   */
  const selectedItems: DetailItem[] = [
    // 先文本行（行号即创建顺序）、后重复待办（createdAt）；再按完成与否稳定排序。
    // 这样"后创建的"不会因为存在 events 表里就跑到最上面。
    ...selectedLines
      .map((text, index) => ({
        type: 'line' as const,
        text,
        index,
        done: isDoneLine(text),
        // pending 期间只改外观、不改排序字段：行留在原位播完 300ms 才重排（MIUI 笔记）
        visualDone: pendingLine?.index === index ? pendingLine.done : isDoneLine(text)
      }))
      .filter((l) => l.text.trim().length > 0),
    ...selectedEvents
      .slice()
      .sort((a, b) => (a.event.createdAt ?? 0) - (b.event.createdAt ?? 0))
      .map((occ) => ({
        type: 'event' as const,
        occ,
        done: occ.done,
        visualDone: occ.done
      }))
  ].sort((a, b) => Number(a.done) - Number(b.done))

  return {
    selectedItems,
    confirmDelete,
    setConfirmDelete,
    toggleEventDone,
    requestRemoveEvent,
    removeEvent,
    skipOne
  }
}
