/**
 * 历史与回滚：快照列表、回到某个时间点、清空记录。
 *
 * 回滚会改库，所以每次回滚完都要把界面拉回与库一致（reloadAll）。
 */
import { useState, type Dispatch, type SetStateAction } from 'react'
import type { SnapshotMeta } from '@shared/types'
import { data } from '../data'

export interface Snapshots {
  snaps: SnapshotMeta[]
  snapMsg: string | null
  /** 历史默认只露 5 条，多的点开看 */
  snapExpanded: boolean
  setSnapExpanded: Dispatch<SetStateAction<boolean>>
  loadSnaps: () => Promise<void>
  restoreSnap: (id: string) => Promise<void>
  clearSnaps: () => Promise<void>
}

export function useSnapshots(opts: { reloadAll: () => Promise<void> }): Snapshots {
  const { reloadAll } = opts
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([])
  const [snapMsg, setSnapMsg] = useState<string | null>(null)
  const [snapExpanded, setSnapExpanded] = useState(false)

  async function loadSnaps(): Promise<void> {
    try {
      setSnaps(await data.snapshots.list())
    } catch (err) {
      setSnapMsg(`读取历史失败：${(err as Error).message}`)
    }
  }

  async function restoreSnap(id: string): Promise<void> {
    const res = await data.snapshots.restore(id)
    if (!res.ok) {
      setSnapMsg(res.error)
      return
    }
    const { restored, deleted, failed } = res.data
    setSnapMsg(
      `已回到该时间点：恢复 ${restored} 条、删除 ${deleted} 条${failed > 0 ? `，失败 ${failed}` : ''}`
    )
    await loadSnaps()
    await reloadAll()
  }

  async function clearSnaps(): Promise<void> {
    const n = await data.snapshots.clear()
    setSnapMsg(`已清空 ${n} 条记录`)
    await loadSnaps()
  }

  return { snaps, snapMsg, snapExpanded, setSnapExpanded, loadSnaps, restoreSnap, clearSnaps }
}
