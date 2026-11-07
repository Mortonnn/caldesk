/**
 * 窗口外壳：主题、窗口开关、设置项镜像、侧面板 / 抽屉 / 详情栏宽度。
 *
 * 这些都是「跟数据无关、只跟这台机器的界面状态有关」的 state，
 * 以前和 52 个 state 挤在同一个组件里，任何一次 setState 都会重跑整棵树。
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { applyMaterials } from '../design/platform'
import { getThemeMode, setThemeMode, type ThemeMode } from '../theme'
import { data } from '../data'
import { read } from './util'

export type PanelKind = 'none' | 'notes' | 'search' | 'settings'

const SIDEBAR_KEY = 'caldesk.sidebarCollapsed'
const DETAIL_WIDTH_KEY = 'caldesk.detailWidth'

export interface Shell {
  /* 主题 */
  theme: ThemeMode
  chooseTheme: (mode: ThemeMode) => void
  /* 窗口 */
  maximized: boolean
  /* 设置项（主进程持有真值，这里是镜像） */
  miniVisible: boolean
  autoStart: boolean
  closeToTray: boolean
  setMiniVisible: (v: boolean) => void
  setAutoStart: (v: boolean) => void
  setCloseToTray: (v: boolean) => void
  /** 重新对齐主进程里的设置真值（打开设置面板时用） */
  refreshSettings: () => void
  /* 侧面板 / 抽屉 */
  panel: PanelKind
  setPanel: (p: PanelKind) => void
  drawerOpen: boolean
  setDrawerOpen: (v: boolean) => void
  /* 侧栏折叠 / 详情栏宽度 */
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  detailWidth: number
  resizing: boolean
  startResize: (e: import('react').PointerEvent<HTMLDivElement>) => void
}

export function useShell(): Shell {
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [maximized, setMaximized] = useState(false)
  const [miniVisible, setMiniVisible] = useState(false)
  /** 开机自启动：默认开，登录后安静进托盘 */
  const [autoStart, setAutoStart] = useState(true)
  /** 关闭主窗口时收进托盘（设置里可关） */
  const [closeToTray, setCloseToTray] = useState(true)
  const [panel, setPanel] = useState<PanelKind>('none')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === '1'
  )
  const [detailWidth, setDetailWidth] = useState(() => {
    const saved = Number(localStorage.getItem(DETAIL_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= 300 ? saved : 400
  })
  /** 拖宽度时把过渡关掉，否则面板会追着鼠标慢半拍 */
  const [resizing, setResizing] = useState(false)

  /* 材质档位要在首帧之前定好，否则会先看到一帧"没有玻璃"的界面 */
  useLayoutEffect(() => {
    applyMaterials()
  }, [])

  useEffect(() => {
    read(data.window.isMaximized(), setMaximized)
    return data.window.onMaximizedChange(setMaximized)
  }, [])

  const refreshSettings = useCallback(() => {
    read(data.settings.get(), (s) => {
      setMiniVisible(s.miniVisible)
      setAutoStart(s.autoStart)
      setCloseToTray(s.closeToTray)
    })
  }, [])

  useEffect(() => {
    refreshSettings()
    read(getThemeMode(), setTheme)
  }, [refreshSettings])

  /** 主题既要落到界面状态，又要写回主进程的 nativeTheme */
  function chooseTheme(mode: ThemeMode): void {
    setTheme(mode)
    void setThemeMode(mode)
  }

  /** 拖动详情面板左边缘调整宽度 */
  function startResize(e: import('react').PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = detailWidth
    const maxWidth = Math.min(Math.round(window.innerWidth * 0.62), 760)
    setResizing(true)

    const onMove = (ev: PointerEvent): void => {
      const next = Math.min(Math.max(startWidth + (startX - ev.clientX), 300), maxWidth)
      setDetailWidth(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setResizing(false)
      setDetailWidth((w) => {
        localStorage.setItem(DETAIL_WIDTH_KEY, String(Math.round(w)))
        return w
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function toggleSidebar(): void {
    setSidebarCollapsed((v) => {
      localStorage.setItem(SIDEBAR_KEY, v ? '0' : '1')
      return !v
    })
  }

  return {
    theme,
    chooseTheme,
    maximized,
    miniVisible,
    autoStart,
    closeToTray,
    setMiniVisible,
    setAutoStart,
    setCloseToTray,
    refreshSettings,
    panel,
    setPanel,
    drawerOpen,
    setDrawerOpen,
    sidebarCollapsed,
    toggleSidebar,
    detailWidth,
    resizing,
    startResize
  }
}
