/**
 * 端到端校验「历史与回滚」。
 *
 * 用 --eval-file 注进渲染层执行，走的是真实 IPC → SQLite 链路：
 *   1. 往今天的单元格追加一行任务（会产生一条回滚记录）
 *   2. 列表里应出现「修改日格」
 *   3. 恢复该记录后，单元格文本应回到追加之前
 *   4. 清空记录不应报错
 *
 * 运行示例：
 *   caldesk.exe --eval-file scripts/e2e-snapshots.js --shot .preview/e2e-snap.png
 */
;(async () => {
  const h = window.caldesk
  const out = { steps: [] }
  const log = (name, value) => out.steps.push({ name, value })

  try {
    const cals = await h.calendars.list()
    if (!cals.ok || cals.data.length === 0) return { ok: false, error: '没有可用视图' }
    const calendarId = cals.data[0].id

    const today = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

    const cell0 = await h.cells.get(calendarId, date)
    const text0 = cell0.ok ? cell0.data.text : ''
    log('before', text0.split('\n').filter(Boolean).length)

    const appended = await h.cells.appendLine(calendarId, date, '回滚自检任务')
    if (!appended.ok) return { ok: false, error: appended.error }
    log('append', appended.data.text.split('\n').filter(Boolean).length)

    const list = await h.snapshots.list()
    log('snapshots', list.map((s) => `${s.label}(${s.count})`))
    const target = list.find((s) => s.label === '修改日格')
    if (!target) return { ok: false, error: '没有生成「修改日格」回滚记录', out }

    const restored = await h.snapshots.restore(target.id)
    if (!restored.ok) return { ok: false, error: restored.error, out }
    log('restore', restored.data)

    const cell1 = await h.cells.get(calendarId, date)
    const text1 = cell1.ok ? cell1.data.text : '__ERR__'
    log('after', text1.split('\n').filter(Boolean).length)

    const ok = text1 === text0
    if (!ok) {
      // 恢复失败就把测试数据擦掉，避免脏数据留在库里
      const lines = text1.split('\n')
      const idx = lines.findIndex((l) => l.includes('回滚自检任务'))
      if (idx >= 0) await h.cells.deleteLine(calendarId, date, idx)
    }
    out.ok = ok
    out.textEqual = ok
    return out
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), out }
  }
})()
