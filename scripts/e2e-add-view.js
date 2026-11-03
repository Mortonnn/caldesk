// 端到端 UI 验证：通过真实点击「新建视图」并输入名称来创建视图
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const newBtn = document.querySelector('.cal-new')
  if (!newBtn) return 'no .cal-new button'
  newBtn.click()
  await sleep(250)

  const input = document.querySelector('.cal-input')
  if (!input) return 'no .cal-input'

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '旅行')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(150)

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await sleep(700)

  const names = [...document.querySelectorAll('.cal-name')].map((n) => n.textContent)
  return JSON.stringify(names)
})()
