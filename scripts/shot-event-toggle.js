/** 截图用：展开事件表单，确认折叠/展开都对 */
;(async () => {
  const btn = document.querySelector('.event-toggle')
  if (!btn) return 'no-toggle'
  const before = document.querySelectorAll('.event-add').length
  btn.click()
  await new Promise((r) => setTimeout(r, 700))
  const after = document.querySelectorAll('.event-add').length
  const selects = document.querySelectorAll('.event-opts select').length
  return `collapsedAdd=${before} expandedAdd=${after} selects=${selects}`
})()
