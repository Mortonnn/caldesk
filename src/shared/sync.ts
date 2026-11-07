/**
 * 同步内核（纯函数，无 IO）。
 *
 * 策略：Last-Write-Wins（LWW）。
 *  - 以 updatedAt 大者胜；
 *  - updatedAt 完全相等时，用 deviceId 字典序大者胜，保证两端算出同一个赢家；
 *  - 删除是墓碑（deletedAt 非空），墓碑同样参与比较，避免"删了又被旧数据复活"。
 *
 * 增量拉取用 `updatedAt > cursor`（严格大于），cursor 取上一次拉到的最大 updatedAt，
 * 边界行不会重复拉取。
 */

export interface SyncRow {
  id: string
  updatedAt: number
  deletedAt?: number | null
}

export type Winner = 'local' | 'remote' | 'equal'

/** 比较两行的版本，返回谁赢 */
export function compareRows(
  local: SyncRow,
  remote: SyncRow,
  localDevice = 'local',
  remoteDevice = 'remote'
): Winner {
  if (remote.updatedAt > local.updatedAt) return 'remote'
  if (remote.updatedAt < local.updatedAt) return 'local'
  // 时间戳相同：用设备 id 打破平局，两端结果一致
  if (remoteDevice === localDevice) return 'equal'
  return remoteDevice > localDevice ? 'remote' : 'local'
}

/** 取出需要在 push 时发送的行（严格大于水位） */
export function diffSince<T extends SyncRow>(rows: T[], sinceExclusive: number): T[] {
  return rows.filter((r) => r.updatedAt > sinceExclusive)
}

export interface MergeResult<T> {
  /** 需要写入本地的行 */
  apply: T[]
  /** 本地更新、需要推给服务端的行（远端更旧） */
  pushBack: T[]
  /** 完全一致，无需动作 */
  unchanged: number
}

/**
 * 把远端拉回的行合并到本地。
 * localRows: 本地现有行（按 id 索引）
 * remoteRows: 远端返回的行
 */
export function mergeRemote<T extends SyncRow>(
  localById: Map<string, T>,
  remoteRows: T[],
  localDevice: string,
  remoteDevice: string
): MergeResult<T> {
  const apply: T[] = []
  const pushBack: T[] = []
  let unchanged = 0

  for (const remote of remoteRows) {
    const local = localById.get(remote.id)
    if (!local) {
      apply.push(remote)
      continue
    }
    const winner = compareRows(local, remote, localDevice, remoteDevice)
    if (winner === 'remote') apply.push(remote)
    else if (winner === 'local') pushBack.push(local)
    else unchanged += 1
  }

  return { apply, pushBack, unchanged }
}

/** 计算下一次拉取的水位（取远端最大 updatedAt，没有则保持原值） */
export function nextCursor<T extends SyncRow>(remoteRows: T[], current: number): number {
  let max = current
  for (const row of remoteRows) {
    if (row.updatedAt > max) max = row.updatedAt
  }
  return max
}
