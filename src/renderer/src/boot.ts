/**
 * 启动期的环境判定：决定渲染主界面还是首次配置页。
 */

export interface BootEnv {
  /** Electron preload 注入了 IPC */
  hasIpc: boolean
  /** 已经有远端配置（注入或本地存储） */
  hasRemote: boolean
}

export function detectEnv(): BootEnv {
  const g = globalThis as unknown as {
    caldesk?: unknown
    __CALDESK_HTTP__?: { url?: string }
  }
  const hasIpc = Boolean(g.caldesk)
  const injected = Boolean(g.__CALDESK_HTTP__?.url)
  let stored = false
  try {
    // 移动端：身份存在 caldesk.identity 里（配对通过后才有 accountId）
    const raw = localStorage.getItem('caldesk.identity')
    if (raw) {
      const parsed = JSON.parse(raw) as { accountId?: string; deviceId?: string }
      stored = Boolean(parsed.accountId && parsed.deviceId)
    } else {
      // 桌面端之外的旧配置：单个令牌
      const old = localStorage.getItem('caldesk.http')
      if (old) {
        const parsed = JSON.parse(old) as { url?: string; token?: string }
        stored = Boolean(parsed.url && parsed.token)
      }
    }
  } catch {
    stored = false
  }
  return { hasIpc, hasRemote: injected || stored }
}

/** 系统主题跟随（不含 Electron 时才自己处理） */
export function applyThemeIfPossible(): void {
  const g = globalThis as unknown as { caldesk?: unknown }
  if (g.caldesk) return
  const mode = localStorage.getItem('caldesk.theme') ?? 'system'
  document.documentElement.dataset.theme = mode
}
