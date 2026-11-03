/** 截图用：打开设置面板并等动画结束 */
;(async () => {
  const btn = document.querySelector('[aria-label="设置"]')
  if (!btn) return 'no-button'
  btn.click()
  await new Promise((r) => setTimeout(r, 1100))
  const rows = document.querySelectorAll('.snap-row').length
  return `settings-open snapshots=${rows}`
})()
