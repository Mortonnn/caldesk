// 端到端验证：新建每周重复任务 + 倒数日，标记一次完成
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const setInput = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const setSelect = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const enter = (el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  const today = [...document.querySelectorAll('.cell')].find((c) =>
    c.querySelector('.daynum.today')
  )
  if (!today) return 'FAIL: no today cell'
  today.click()
  await sleep(320)

  const eventInput = () => document.querySelector('.event-add .task-input')
  const selects = () => [...document.querySelectorAll('.event-opts .mini-select')]

  // 1) 每周重复任务
  if (selects()[1]) setSelect(selects()[1], 'weekly')
  await sleep(120)
  setInput(eventInput(), '每周例会')
  await sleep(120)
  enter(eventInput())
  await sleep(700)

  // 2) 倒数日
  if (selects()[0]) setSelect(selects()[0], 'countdown')
  await sleep(120)
  setInput(eventInput(), '年会倒计时')
  await sleep(120)
  enter(eventInput())
  await sleep(700)

  // 3) 标记第一条事件完成
  const box = document.querySelector('.event-row .checkbox')
  if (box) {
    box.click()
    await sleep(500)
  }

  const gridEvents = [...document.querySelectorAll('.cell .ev')].map((e) => e.textContent)
  const rows = [...document.querySelectorAll('.event-row')].map((r) => ({
    kind: r.querySelector('.ev-kind')?.textContent,
    title: r.querySelector('.task-text')?.textContent,
    meta: [...r.querySelectorAll('.ev-meta')].map((m) => m.textContent),
    done: r.classList.contains('done')
  }))

  return JSON.stringify({ gridEvents, rows })
})()
