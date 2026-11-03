// 端到端：新建便签 → 搜索命中 → 截图
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const setInput = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const byText = (sel, text) =>
    [...document.querySelectorAll(sel)].find((b) => b.textContent.trim().includes(text))

  // 打开便签面板
  document.querySelector('[aria-label="便签"]')?.click()
  await sleep(500)

  // 新建
  const newBtn = byText('.panel-actions .ghost', '新建')
  if (!newBtn) return 'FAIL: 找不到新建按钮'
  newBtn.click()
  await sleep(300)

  const titleInput = document.querySelector('.note-editor .task-input')
  const contentArea = document.querySelector('.note-text')
  if (!titleInput || !contentArea) return 'FAIL: 编辑器字段缺失'

  setInput(titleInput, '装修清单')
  await sleep(120)
  setInput(contentArea, '买沙发；换灯；装窗帘')
  await sleep(150)

  document.querySelector('.primary-btn')?.click()
  await sleep(700)

  const noteTitles = [...document.querySelectorAll('.note-title')].map((n) => n.textContent)

  // 打开搜索
  document.querySelector('[aria-label="搜索"]')?.click()
  await sleep(500)
  const searchInput = document.querySelector('.panel .task-input')
  if (!searchInput) return 'FAIL: 搜索输入框缺失'
  setInput(searchInput, '窗帘')
  await sleep(900)

  const results = [...document.querySelectorAll('.result-row')].map((r) => ({
    kind: r.querySelector('.ev-kind')?.textContent,
    title: r.querySelector('.result-title')?.textContent
  }))

  return JSON.stringify({ noteTitles, results })
})()
