/**
 * 设置面板：主题 / 启动 / 浮窗 / 同步 / 历史回滚 / AI 配置指南。
 *
 * 每一块都长同一个样子：`.set-block` 里一行标题（`.set-head` + `.pop-label`）→
 * 说明 / 控件 → 操作按钮行（`.note-actions`）。间距、圆角、字号全部走 tokens，
 * 新增区块时照抄这个结构就不会显得像"贴上去的"。
 */
import { useEffect, useState } from 'react'
import { APP_VERSION, DEFAULT_SERVER_URL, PROJECT_URL, hasDefaultServer } from '@shared/identity'
import {
  MINI_MAX_HEIGHT,
  MINI_MAX_WIDTH,
  MINI_MIN_HEIGHT,
  MINI_MIN_WIDTH,
  MINI_RANGE_LABEL,
  MINI_RANGE_ORDER,
  MINI_SIZE_PRESETS,
  MINI_VIEW_LABEL,
  MINI_VIEW_ORDER
} from '@shared/mini'
import { THEME_LABEL, THEME_ORDER } from '../theme'
import { data } from '../data'
import { buildAiGuide } from './aiGuide'
import { SNAP_PREVIEW, TABLE_LABEL, read, stampOf } from './util'
import type { Shell } from './useShell'
import type { Snapshots } from './useSnapshots'
import type { SyncState } from './useSyncState'

/**
 * 认证区的两枚辅助按钮：恢复默认服务器 / 生成强密码。
 *
 * 都是次级操作，所以一律 ghost，等宽铺满一行；真正的主动作（登录 / 设置账号密码）
 * 单独一行放在下面，视觉上比它们重。
 * 源码自编译的版本没有内置服务器（hasDefaultServer() 为假），那个按钮整个不渲染 ——
 * 点了没反应比不显示更让人困惑。
 */
function AuthActions(props: {
  showRestore: boolean
  showGenerate: boolean
  onRestore: () => void
  onGenerate: () => void
}): React.JSX.Element | null {
  const { showRestore, showGenerate, onRestore, onGenerate } = props
  if (!showRestore && !showGenerate) return null
  return (
    <div className="auth-actions">
      {showRestore && (
        <button className="ghost" onClick={onRestore}>
          恢复默认服务器
        </button>
      )}
      {showGenerate && (
        <button className="ghost" onClick={onGenerate}>
          生成强密码
        </button>
      )}
    </div>
  )
}

export function SettingsPanel(props: {
  shell: Shell
  sync: SyncState
  snaps: Snapshots
}): React.JSX.Element {
  const { shell, sync, snaps } = props
  const {
    theme,
    chooseTheme,
    miniVisible,
    setMiniVisible,
    miniRange,
    setMiniRange,
    miniView,
    setMiniView,
    miniWidth,
    miniHeight,
    setMiniSize,
    autoStart,
    setAutoStart,
    closeToTray,
    setCloseToTray
  } = shell
  const {
    syncUrl,
    setSyncUrl,
    syncPaired,
    syncUsername,
    authMode,
    setAuthMode,
    authUser,
    setAuthUser,
    authPassword,
    setAuthPassword,
    authBusy,
    syncMsg,
    setSyncMsg,
    syncing,
    deviceList,
    syncOnline,
    saveSyncServer,
    restoreDefaultServer,
    fillStrongPassword,
    submitAuth,
    claimExisting,
    logoutSync,
    revokeDevice,
    runSyncNow
  } = sync
  const { snaps: snapList, snapMsg, snapExpanded, setSnapExpanded, restoreSnap, clearSnaps } = snaps

  const [mcpInfo, setMcpInfo] = useState<{ port: number | null; url: string | null } | null>(null)
  const [guideCopied, setGuideCopied] = useState(false)

  /* 打开设置面板就等于挂载本组件：顺手问一次 MCP 端口，指南里的地址才不会写错 */
  useEffect(() => {
    read(data.mcp.getInfo(), setMcpInfo)
  }, [])

  const guide = buildAiGuide({ port: mcpInfo?.port ?? null, url: mcpInfo?.url ?? null })
  const canRestoreServer = hasDefaultServer()
  /** 当前尺寸正好落在某一档预设上时高亮那一档；Windows 高 DPI 下 setBounds 可能回 1px 误差，留 2px 容差 */
  const activeSizePreset = MINI_SIZE_PRESETS.find(
    (p) => Math.abs(p.width - miniWidth) <= 2 && Math.abs(p.height - miniHeight) <= 2
  )
  /** 当前尺寸不等于任何预设 → 浮窗大小里多出「自定义」并自动选中 */
  const isCustomSize = !activeSizePreset
  const [resWidth, setResWidth] = useState(String(miniWidth))
  const [resHeight, setResHeight] = useState(String(miniHeight))

  /* 点预设 / 拖把手 / 主进程广播尺寸变化时，分辨率输入框跟着走 */
  useEffect(() => {
    const matched = MINI_SIZE_PRESETS.find(
      (p) => Math.abs(p.width - miniWidth) <= 2 && Math.abs(p.height - miniHeight) <= 2
    )
    setResWidth(String(matched?.width ?? miniWidth))
    setResHeight(String(matched?.height ?? miniHeight))
  }, [miniWidth, miniHeight])

  const parsedResWidth = Math.round(Number(resWidth))
  const parsedResHeight = Math.round(Number(resHeight))
  const resValid =
    Number.isFinite(parsedResWidth) &&
    Number.isFinite(parsedResHeight) &&
    parsedResWidth >= MINI_MIN_WIDTH &&
    parsedResWidth <= MINI_MAX_WIDTH &&
    parsedResHeight >= MINI_MIN_HEIGHT &&
    parsedResHeight <= MINI_MAX_HEIGHT

  function applyMiniResolution(): void {
    if (!resValid) return
    setMiniSize(parsedResWidth, parsedResHeight)
    read(
      data.mini.setSize(parsedResWidth, parsedResHeight),
      (r) => {
        setMiniSize(r.width, r.height)
        setResWidth(String(r.width))
        setResHeight(String(r.height))
      },
      (e) => setSyncMsg(`浮窗分辨率设置失败：${e.message}`)
    )
  }

  function copyGuide(): void {
    void navigator.clipboard.writeText(guide).then(() => {
      setGuideCopied(true)
      setTimeout(() => setGuideCopied(false), 2000)
    })
  }

  return (
    <div className="panel-body set-body">
      <section className="set-block">
        <span className="pop-label">主题</span>
        <div className="seg-group">
          {THEME_ORDER.map((m) => (
            <button
              key={m}
              className={`seg-item ${theme === m ? 'on' : ''}`}
              onClick={() => chooseTheme(m)}
            >
              {THEME_LABEL[m]}
            </button>
          ))}
        </div>
      </section>

      <section className="set-block">
        <span className="pop-label">启动</span>
        <div className="pop-row">
          <span className="pop-label-row">开机自启动</span>
          <button
            role="switch"
            aria-checked={autoStart}
            className={`switch ${autoStart ? 'on' : ''}`}
            onClick={() => {
              const next = !autoStart
              setAutoStart(next)
              read(data.settings.setAutoStart(next), () => {}, (e) =>
                setSyncMsg(`开机自启动设置失败：${e.message}`)
              )
            }}
          >
            <span className="switch-knob" />
          </button>
        </div>
        <div className="pop-row">
          <span className="pop-label-row">关闭后进入托盘</span>
          <button
            role="switch"
            aria-checked={closeToTray}
            className={`switch ${closeToTray ? 'on' : ''}`}
            onClick={() => {
              const next = !closeToTray
              setCloseToTray(next)
              read(data.settings.setCloseToTray(next), () => {}, (e) =>
                setSyncMsg(`托盘设置失败：${e.message}`)
              )
            }}
          >
            <span className="switch-knob" />
          </button>
        </div>
      </section>

      <section className="set-block">
        <div className="pop-row">
          <span className="pop-label-row">桌面浮窗</span>
          <button
            role="switch"
            aria-checked={miniVisible}
            className={`switch ${miniVisible ? 'on' : ''}`}
            onClick={() => {
              const next = !miniVisible
              setMiniVisible(next)
              read(data.mini.setVisible(next), () => {}, (e) =>
                setSyncMsg(`浮窗设置失败：${e.message}`)
              )
            }}
          >
            <span className="switch-knob" />
          </button>
        </div>

        {/* 显示样式：列表是原来的日程流，月视图是整月九宫格 */}
        <div className="pop-row">
          <span className="pop-label-row">显示样式</span>
          <div className="seg-group mini-seg mini-view-seg">
            {MINI_VIEW_ORDER.map((v) => (
              <button
                key={v}
                className={`seg-item ${miniView === v ? 'on' : ''}`}
                onClick={() => {
                  setMiniView(v)
                  read(data.settings.setMiniView(v), () => {}, (e) =>
                    setSyncMsg(`浮窗样式设置失败：${e.message}`)
                  )
                }}
              >
                {MINI_VIEW_LABEL[v]}
              </button>
            ))}
          </div>
        </div>

        {/* 月视图天然按整月显示，范围选项只在列表模式下有意义，直接收起 */}
        {miniView === 'list' && (
          <div className="pop-row">
            <span className="pop-label-row">显示范围</span>
            <div className="seg-group mini-seg mini-range-seg">
              {MINI_RANGE_ORDER.map((m) => (
                <button
                  key={m}
                  className={`seg-item ${miniRange === m ? 'on' : ''}`}
                  onClick={() => {
                    setMiniRange(m)
                    read(data.settings.setMiniRange(m), () => {}, (e) =>
                      setSyncMsg(`浮窗范围设置失败：${e.message}`)
                    )
                  }}
                >
                  {MINI_RANGE_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 预设只是快捷入口；拖把手自由缩放后尺寸不等于任何预设，就多出一档「自定义」 */}
        <div className="pop-row">
          <span className="pop-label-row">浮窗大小</span>
          <div className="seg-group mini-seg mini-size-seg">
            {MINI_SIZE_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`seg-item ${activeSizePreset?.id === p.id ? 'on' : ''}`}
                title={`${p.width} × ${p.height}`}
                onClick={() => {
                  setMiniSize(p.width, p.height)
                  read(
                    data.mini.setSize(p.width, p.height),
                    (r) => setMiniSize(r.width, r.height),
                    (e) => setSyncMsg(`浮窗大小设置失败：${e.message}`)
                  )
                }}
              >
                {p.label}
              </button>
            ))}
            {isCustomSize && (
              <button
                className="seg-item on"
                title={`${miniWidth} × ${miniHeight}`}
                aria-pressed="true"
              >
                自定义
              </button>
            )}
          </div>
        </div>

        {/* 分辨率输入：点预设时自动带出对应宽高；手动应用后浮窗大小自动跳到「自定义」 */}
        <div className="pop-row mini-res-row">
          <span className="pop-label-row">浮窗分辨率</span>
          <div className="mini-res-control">
            <input
              className="mini-res-input"
              type="number"
              inputMode="numeric"
              aria-label="浮窗宽度"
              min={MINI_MIN_WIDTH}
              max={MINI_MAX_WIDTH}
              value={resWidth}
              onChange={(e) => setResWidth(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyMiniResolution()
              }}
            />
            <span className="mini-res-x">×</span>
            <input
              className="mini-res-input"
              type="number"
              inputMode="numeric"
              aria-label="浮窗高度"
              min={MINI_MIN_HEIGHT}
              max={MINI_MAX_HEIGHT}
              value={resHeight}
              onChange={(e) => setResHeight(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyMiniResolution()
              }}
            />
            <button
              className="ghost mini-res-apply"
              disabled={!resValid}
              title={`范围 ${MINI_MIN_WIDTH}–${MINI_MAX_WIDTH} × ${MINI_MIN_HEIGHT}–${MINI_MAX_HEIGHT}`}
              onClick={applyMiniResolution}
            >
              应用
            </button>
          </div>
        </div>
      </section>

      <section className="set-block">
        <span className="pop-label">同步</span>

        <div className="sync-server">
          <input
            className="task-input"
            placeholder={DEFAULT_SERVER_URL || '服务器地址'}
            value={syncUrl}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(e) => setSyncUrl(e.target.value)}
          />
          <button className="ghost" onClick={() => void saveSyncServer()}>
            保存
          </button>
        </div>

        {syncPaired ? (
          <div className="sync-paired">
            <div className="pop-row">
              <span className="pop-label-row">{syncUsername || '配对账号 · 未设密码'}</span>
              <button className="ghost" onClick={() => void logoutSync()}>
                退出登录
              </button>
            </div>

            {!syncUsername && (
              <div className="sync-create">
                <input
                  className="task-input"
                  placeholder="用户名"
                  autoCapitalize="none"
                  value={authUser}
                  onChange={(e) => setAuthUser(e.target.value)}
                />
                <input
                  className="task-input"
                  type="password"
                  placeholder="密码"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                />
                <AuthActions
                  showRestore={canRestoreServer}
                  showGenerate
                  onRestore={() => void restoreDefaultServer()}
                  onGenerate={fillStrongPassword}
                />
                <div className="note-actions">
                  <button
                    className="primary-btn auth-primary"
                    disabled={authBusy}
                    onClick={() => void claimExisting()}
                  >
                    设置账号密码
                  </button>
                </div>
              </div>
            )}

            <div className="note-actions">
              <button
                className="primary-btn"
                disabled={syncing}
                onClick={() => void runSyncNow()}
              >
                {syncing ? '同步中…' : '立即同步'}
              </button>
            </div>

            {deviceList.length > 0 && (
              <div className="pair-list">
                <div className="pop-row">
                  <span className="pop-label-row">
                    已登录设备{syncOnline > 0 ? ` · ${syncOnline} 台在线` : ''}
                  </span>
                </div>
                {deviceList.map((d) => (
                  <div key={d.deviceId} className="pair-row">
                    <span className="snap-label">
                      {d.name || d.deviceId.slice(0, 8)}
                      {d.current ? '（本机）' : ''}
                    </span>
                    {!d.current && (
                      <button
                        className="ghost"
                        onClick={() => void revokeDevice(d.deviceId)}
                        title="删除这台设备"
                      >
                        删除
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="sync-create">
            <div className="seg-group">
              <button
                className={`seg-item ${authMode === 'login' ? 'on' : ''}`}
                onClick={() => setAuthMode('login')}
              >
                登录
              </button>
              <button
                className={`seg-item ${authMode === 'register' ? 'on' : ''}`}
                onClick={() => setAuthMode('register')}
              >
                注册
              </button>
            </div>
            <input
              className="task-input"
              placeholder="用户名"
              autoCapitalize="none"
              autoCorrect="off"
              value={authUser}
              onChange={(e) => setAuthUser(e.target.value)}
            />
            <input
              className="task-input"
              type="password"
              placeholder="密码"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
            />
            {/* 登录页不提供「生成强密码」：密码是用户自己在别处设过的，生成一个只会让人以为要重设 */}
            <AuthActions
              showRestore={canRestoreServer}
              showGenerate={authMode === 'register'}
              onRestore={() => void restoreDefaultServer()}
              onGenerate={fillStrongPassword}
            />
            <div className="note-actions">
              <button
                className="primary-btn auth-primary"
                disabled={authBusy}
                onClick={() => void submitAuth()}
              >
                {authBusy ? '处理中…' : authMode === 'login' ? '登录' : '注册并登录'}
              </button>
            </div>
          </div>
        )}
        {syncMsg && <span className="hint">{syncMsg}</span>}
      </section>

      <section className="set-block">
        <div className="set-head">
          <span className="pop-label">历史与回滚</span>
          <span className="set-count">{snapList.length} / 100</span>
        </div>
        {snapList.length === 0 ? (
          <p className="empty">还没有可回滚的记录</p>
        ) : (
          <>
            {(snapExpanded ? snapList : snapList.slice(0, SNAP_PREVIEW)).map((s) => (
              <div key={s.id} className={`snap-row ${s.current ? 'is-current' : ''}`}>
                <div className="snap-main">
                  <span className="snap-label">
                    {s.label}
                    {s.current && <span className="snap-badge">最新</span>}
                  </span>
                  <span className="snap-meta">
                    {stampOf(s.updatedAt)} · {s.count} 处 ·{' '}
                    {s.tables.map((t) => TABLE_LABEL[t] ?? t).join('、')}
                  </span>
                </div>
                {/* 每一条都能点回去，包括「最新」那条 ——
                    它记录的是「最后一次修改之前」的状态，点它就是把最后一笔改回来。
                    以前这里用 !s.current 把它藏起来，结果「撤销最后一笔编辑」这个最常用的操作反而点不到。 */}
                <button className="ghost snap-restore" onClick={() => void restoreSnap(s.id)}>
                  回到这里
                </button>
              </div>
            ))}
            {snapList.length > SNAP_PREVIEW && (
              <button className="snap-more" onClick={() => setSnapExpanded(!snapExpanded)}>
                {snapExpanded ? '收起' : `展开剩余 ${snapList.length - SNAP_PREVIEW} 条`}
              </button>
            )}
          </>
        )}
        <div className="note-actions">
          <button className="ghost" disabled={snapList.length === 0} onClick={() => void clearSnaps()}>
            清空记录
          </button>
        </div>
        {snapMsg && <span className="hint">{snapMsg}</span>}
      </section>

      <section className="set-block">
        <div className="set-head">
          <span className="pop-label">AI 配置指南</span>
        </div>
        <p className="hint">
          复制下面的文本发给你的 AI Agent，重启 Agent 后它就能直接增删查改日历。服务只在本机可用。
        </p>
        <textarea className="ai-guide-text" readOnly value={guide} spellCheck={false} />
        <div className="note-actions">
          <button className="primary-btn" onClick={copyGuide}>
            {guideCopied ? '已复制 ✓' : '复制'}
          </button>
        </div>
      </section>

      {/* 关于：保持和其它区块同一套骨架（.set-block → .set-head → .pop-row → .hint），
          链接用 target="_blank"，由主进程的 setWindowOpenHandler 交给系统浏览器，
          不会在应用窗口里导航走。 */}
      <section className="set-block">
        <div className="set-head">
          <span className="pop-label">关于</span>
          <span className="set-count">v{APP_VERSION}</span>
        </div>
        <div className="pop-row">
          <span className="pop-label-row">开源仓库</span>
          <a
            className="ghost about-link"
            href={PROJECT_URL}
            target="_blank"
            rel="noreferrer noopener"
            title={PROJECT_URL}
          >
            {PROJECT_URL.replace(/^https:\/\//, '')}
          </a>
        </div>
        <p className="hint">内置 MCP 服务，AI 客户端可以直接读写日程；配一个 Cloudflare Worker 就能和手机同步。代码开源，欢迎提 issue。</p>
      </section>
    </div>
  )
}
