/** 量格子容量：可放几行（由高度算出来）vs 当前最多渲染了几行 */
;(async () => {
  const probe = document.querySelector('.cell-row-probe')
  const body = document.querySelector('.cell .cell-body')
  if (!probe || !body) return 'no-probe'
  const rowH = probe.getBoundingClientRect().height
  const capacity = Math.max(1, Math.floor(body.clientHeight / rowH))
  const cells = Array.from(document.querySelectorAll('.cell'))
  const counts = cells.map((c) => c.querySelectorAll('.ev, .line, .cell-more').length)
  const maxRendered = Math.max(...counts, 0)
  return `rowH=${rowH.toFixed(1)} capacity=${capacity} maxRendered=${maxRendered}`
})()
