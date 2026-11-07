/**
 * 顶栏：品牌、侧栏开关、离线小标、三个工具按钮、窗口标题栏按钮。
 *
 * 只吃 props —— 这里没有任何自己的状态，重渲染由 App 的壳状态决定。
 * 注意 `aria-label="设置"` 这个字符串被主进程 `--open-settings` 直接
 * querySelector 命中，改名会让启动参数失效。
 */
import { CalMark, Menu, Note as NoteIcon, PanelLeft, Search, Settings, WinClose, WinMaximize, WinMinimize, WinRestore } from '../icons'
import { data } from '../data'
import type { PanelKind } from './useShell'

export function Titlebar(props: {
  maximized: boolean
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  onToggleDrawer: () => void
  panel: PanelKind
  /** 搜索 / 便签按钮：同一个面板再点一次就关掉 */
  onTogglePanel: (p: 'notes' | 'search') => void
  onOpenSettings: () => void
  offline: boolean
  onRetry: () => void
}): React.JSX.Element {
  const {
    maximized,
    sidebarCollapsed,
    onToggleSidebar,
    onToggleDrawer,
    panel,
    onTogglePanel,
    onOpenSettings,
    offline,
    onRetry
  } = props

  return (
    <header className="titlebar">
      <div className="titlebar-drag">
        <button
          className="sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
          title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <PanelLeft />
        </button>
        <button className="menu-btn" onClick={onToggleDrawer} aria-label="切换侧栏">
          <Menu />
        </button>
        <span className="brand-mark">
          <CalMark size={18} />
        </span>
        <span className="brand">caldesk</span>
      </div>

      <div className="titlebar-tools">
        {offline && (
          <button className="net-chip" title="连不上服务器，点一下重试" onClick={onRetry}>
            <span className="net-chip-dot" />
            离线
          </button>
        )}
        <button
          className={`tool-btn ${panel === 'search' ? 'active' : ''}`}
          onClick={() => onTogglePanel('search')}
          title="搜索"
          aria-label="搜索"
        >
          <Search />
        </button>
        <button
          className={`tool-btn ${panel === 'notes' ? 'active' : ''}`}
          onClick={() => onTogglePanel('notes')}
          title="便签"
          aria-label="便签"
        >
          <NoteIcon />
        </button>
        <button
          className={`tool-btn ${panel === 'settings' ? 'active' : ''}`}
          onClick={onOpenSettings}
          aria-label="设置"
          title="设置"
        >
          <Settings />
        </button>
      </div>

      <div className="caption-buttons">
        <button
          className="caption-btn"
          onClick={() => void data.window.minimize()}
          aria-label="最小化"
        >
          <WinMinimize />
        </button>
        <button
          className="caption-btn"
          onClick={() => void data.window.toggleMaximize()}
          aria-label={maximized ? '向下还原' : '最大化'}
        >
          {maximized ? <WinRestore /> : <WinMaximize />}
        </button>
        <button className="caption-btn close" onClick={() => void data.window.close()} aria-label="关闭">
          <WinClose />
        </button>
      </div>
    </header>
  )
}
