/** 验证：详情面板里勾选事件能真正写库（浮窗的勾选走同一个 IPC） */
;(async () => {
  const box = document.querySelector('.event-row .checkbox')
  if (!box) return 'no-checkbox'
  const before = box.className
  box.click()
  await new Promise((r) => setTimeout(r, 900))
  const after = document.querySelector('.event-row .checkbox').className
  // 复原，避免污染用户数据
  document.querySelector('.event-row .checkbox').click()
  await new Promise((r) => setTimeout(r, 600))
  const restored = document.querySelector('.event-row .checkbox').className
  return `before=${before} after=${after} restored=${restored}`
})()
