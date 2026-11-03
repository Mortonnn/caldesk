/**
 * 验证跨窗口刷新广播：任意一端写入后，两个窗口都应收到 data:changed 并重读。
 * 这里在主窗口里挂监听，触发一次真实写入（追加再删除），看回调是否被叫到、
 * 以及界面上的单元格是否跟着刷新。
 */
;(async () => {
  const h = window.caldesk
  let fired = 0
  const off = h.onDataChanged(() => {
    fired += 1
  })

  const cals = await h.calendars.list()
  const cal = cals.data[0].id
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  const cell = await h.cells.get(cal, date)
  const before = cell.ok ? cell.data.text.split('\n').filter(Boolean).length : 0

  const added = await h.cells.appendLine(cal, date, '跨窗口自检')
  await new Promise((r) => setTimeout(r, 500))
  const afterAdd = document.querySelector('.cell.selected')?.innerText ?? ''

  // 收尾：删掉刚加的那行
  const idx = (added.ok ? added.data.text : '').split('\n').indexOf('跨窗口自检')
  if (idx >= 0) await h.cells.deleteLine(cal, date, idx)
  await new Promise((r) => setTimeout(r, 500))

  const cell2 = await h.cells.get(cal, date)
  const after = cell2.ok ? cell2.data.text.split('\n').filter(Boolean).length : -1

  off()
  return `fired=${fired} linesBefore=${before} linesAfterCleanup=${after} uiHasNew=${afterAdd.includes('跨窗口自检')}`
})()
