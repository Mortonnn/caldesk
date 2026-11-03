// 探针：验证 Electron 主进程的 console 输出与 fetch 是否可用
const { app } = require('electron')

console.log('BOOT: console 可用')

app.whenReady().then(async () => {
  console.log('READY: app ready')
  try {
    const res = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(5000) })
    console.log('FETCH OK:', res.status, await res.text())
  } catch (err) {
    console.log('FETCH FAIL:', err.message)
  }
  console.log('DONE')
  // 延迟退出，确保 stdout 冲刷
  setTimeout(() => app.exit(0), 300)
})
