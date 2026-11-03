/** 截图用：把重复规则切成「自定义…」，检查只填天数的输入框 */
;(async () => {
  const sels = Array.from(document.querySelectorAll('.event-opts select'))
  if (sels.length < 2) return `selects=${sels.length}`
  const rep = sels[1]
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'value'
  ).set
  setter.call(rep, 'custom')
  rep.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 600))
  const input = document.querySelector('.custom-repeat-input')
  return `custom input=${input ? input.value : 'missing'} kind=${sels[0].value}`
})()
