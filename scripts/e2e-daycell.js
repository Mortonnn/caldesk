// 端到端验证：写入两条日格任务 → 标记第一条完成 → 切换视图验证隔离
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const setValue = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const typeAndEnter = async (text) => {
    // 详情面板里有两个 .task-input（事件 / 任务），按 placeholder 精确取任务那个
    const input = [...document.querySelectorAll('.task-input')].find((el) =>
      (el.getAttribute('placeholder') || '').includes('添加一条任务')
    )
    if (!input) return false
    setValue(input, text)
    await sleep(120)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(550)
    return true
  }

  const today = [...document.querySelectorAll('.cell')].find((c) =>
    c.querySelector('.daynum.today')
  )
  if (!today) return 'FAIL: no today cell'
  today.click()
  await sleep(320)

  if (!(await typeAndEnter('测试任务A'))) return 'FAIL: no task input'
  await typeAndEnter('测试任务B')

  const box = document.querySelector('.task-row .checkbox')
  if (box) {
    box.click()
    await sleep(520)
  }

  const rows = [...document.querySelectorAll('.task-row')].map((r) => ({
    text: r.querySelector('.task-text')?.textContent,
    done: r.classList.contains('done')
  }))

  // 切换视图，验证日格按视图隔离
  const cals = [...document.querySelectorAll('.cal-item')]
  let otherView = null
  if (cals[1]) {
    cals[1].click()
    await sleep(650)
    otherView = {
      rows: document.querySelectorAll('.task-row').length,
      empty: document.querySelector('.empty')?.textContent ?? null,
      name: document.querySelector('.detail header p')?.textContent ?? null
    }
    cals[0].click()
    await sleep(650)
  }

  return JSON.stringify({ rows, otherView })
})()
