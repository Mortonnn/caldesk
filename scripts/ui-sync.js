/**
 * 桌面端同步 UI 交互验证：走一遍「填地址 → 建账号 → 出二维码 → 待批准设备」。
 * 用法：caldesk.exe --eval-file scripts/ui-sync.js
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findByText(sel, text) {
  const list = [...document.querySelectorAll(sel)]
  return list.find((el) => (el.innerText || '').trim().includes(text)) ?? null
}

async function setInput(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

const report = []
const log = (m) => {
  report.push(m)
  console.log('[ui-sync] ' + m)
}

async function main() {
  await sleep(600)
  // 打开设置面板：顶栏的齿轮图标
  const gear = document.querySelector('[aria-label="设置"]')
  if (gear) {
    gear.click()
    log('clicked gear')
  } else {
    log('gear not found; aria-labels=' + JSON.stringify([...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'))))
  }
  await sleep(1200)

  const inputs = [...document.querySelectorAll('input.task-input')]
  log(`task-input count = ${inputs.length}`)
  const texts = [...document.querySelectorAll('.set-block')].map((b) => b.innerText.slice(0, 40))
  log('set-blocks=' + JSON.stringify(texts))

  // 第一个是服务器地址，第二个是设备名
  if (inputs.length >= 1) {
    await setInput(inputs[0], 'https://caldesk.ilikeu.cc.cd')
    log('filled server url')
  }
  if (inputs.length >= 2) {
    await setInput(inputs[1], '验收电脑')
    log('filled device name')
  }

  // 保存
  const saveBtn = [...document.querySelectorAll('button')].find(
    (b) => b.innerText.trim() === '保存'
  )
  if (saveBtn) {
    saveBtn.click()
    log('clicked save')
  }
  await sleep(1200)

  const body = document.body.innerText
  log('has 创建账号 button: ' + body.includes('创建账号'))
  log('has 同步（Cloudflare）: ' + body.includes('同步（Cloudflare）'))
  log('has 服务器地址 label: ' + body.includes('服务器地址'))

  // 把日志塞回 DOM，方便从截图/日志里看
  const box = document.createElement('pre')
  box.id = 'ui-sync-report'
  box.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:99999;background:#111;color:#0f0;font-size:12px;padding:8px;max-width:90vw;white-space:pre-wrap'
  box.textContent = report.join('\n')
  document.body.appendChild(box)
}

main().catch((e) => {
  console.log('[ui-sync] error: ' + e.message)
  window.__uiSyncReport = [...report, 'ERROR ' + e.message]
})
