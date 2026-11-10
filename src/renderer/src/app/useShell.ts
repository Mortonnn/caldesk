/**
 * 窗口外壳：主题、窗口开关、设置项镜像、侧面板 / 抽屉 / 详情栏宽度。
 *
 * 这些都是「跟数据无关、只跟这台机器的界面状态有关」的 state，
 * 以前和 52 个 state 挤在同一个组件里，任何一次 setState 都会重跑整棵树。
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { DEFAULT_MINI_HEIGHT, DEFAULT_MINI_WIDTH, type MiniRange, type MiniView } from '@shared/mini'
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
  /** 浮窗显示范围 / 实际尺寸：设置面板的分段高亮靠它们 */
  miniRange: MiniRange
  miniView: MiniView
  miniWidth: number
  miniHeight: number
  setMiniVisible: (v: boolean) => void
  setMiniRange: (range: MiniRange) => void
  setMiniView: (view: MiniView) => void
  setMiniSize: (width: number, height: number) => void
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
  /** 浮窗范围/尺寸：和 miniVisible 一样只是镜像，真值在主进程 */
  const [miniRange, setMiniRangeState] = useState<MiniRange>('month')
  const [miniView, setMiniViewState] = useState<MiniView>('list')
  const [miniWidth, setMiniWidth] = useState(DEFAULT_MINI_WIDTH)
  const [miniHeight, setMiniHeight] = useState(DEFAULT_MINI_HEIGHT)
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
      setMiniRangeState(s.miniRange)
      setMiniViewState(s.miniView)
      setMiniWidth(s.miniWidth)
      setMiniHeight(s.miniHeight)
      setAutoStart(s.autoStart)
      setCloseToTray(s.closeToTray)
    })
  }, [])

  useEffect(() => {
    refreshSettings()
    read(getThemeMode(), setTheme)
    // 主进程改了浮窗范围/尺寸（设置面板、托盘、另一块屏拖动）都会广播，
    // 这里重新对齐镜像，分段控件的高亮才不会和真实窗口脱节
    return data.onSettingsChanged(refreshSettings)
  }, [refreshSettings])

  /** 主题既要落到界面状态，又要写回主进程的 nativeTheme */
  function chooseTheme(mode: ThemeMode): void {
    setTheme(mode)
    void setThemeMode(mode)
  }

  /** 浮窗尺寸是「宽 + 高」两个 state，设置面板点一次预设要一起改 */
  function setMiniSize(width: number, height: number): void {
    setMiniWidth(width)
    setMiniHeight(height)
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
    miniRange,
    miniView,
    miniWidth,
    miniHeight,
    autoStart,
    closeToTray,
    setMiniVisible,
    setMiniRange: setMiniRangeState,
    setMiniView: setMiniViewState,
    setMiniSize,
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
