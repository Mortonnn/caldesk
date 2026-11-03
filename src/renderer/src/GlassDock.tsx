/**
 * 液态玻璃底栏（照 FlClash 安卓版的 FloatingNavigationBar 做的手感）。
 *
 * 布局：整条浮在屏幕底部，左边 3/4 是玻璃 dock（3 个图标），
 * 右边 1/4 是圆形的 + 号。
 *
 * 玻璃感来自三层叠加：
 *   1. backdrop-filter: blur + saturate —— 真的把背后的内容揉成一片；
 *   2. 半透明白/黑渐变 —— 给玻璃一点厚度；
 *   3. 内阴影 + 高光描边 —— 玻璃的边缘折射感。
 *
 * 跟手（与 FlClash 一致）：
 *   - 按下：药丸立刻弹到手指按住的那一格；
 *   - 拖动：药丸贴着手指走，跨格给一次轻震动；
 *   - 松手：**才**提交手指下的那一格；
 *   - 手势被系统取消（横滑被浏览器/系统抢走）：回弹到原来那格，不提交。
 *
 * 早先的实现把 pointercancel 当成松手提交，安卓上横滑会被系统手势抢走，
 * 取消点又落在最左边，于是就出现"设置往左一滑直接跳到日历"。
 * 另外 dock 必须声明 touch-action: none，否则浏览器不会把横向手势交给我们。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'

export interface DockItem {
  key: string
  label: string
  icon: React.ReactNode
}

/** 手指移动超过这个距离才算拖动，否则当成一次点按（同 Flutter 的 kTouchSlop 思路） */
const DRAG_SLOP = 8

const plusIcon = (
  <svg
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
)

/** 跨格时的一次轻震动：安卓上就是 FlClash 的 selectionClick */
function tick(): void {
  try {
    navigator.vibrate?.(8)
  } catch {
    /* 不支持震动就算了 */
  }
}

export function GlassDock({
  items,
  active,
  onSelect,
  onAdd
}: {
  items: DockItem[]
  active: string
  onSelect: (key: string) => void
  onAdd: () => void
}): React.JSX.Element {
  const dockRef = useRef<HTMLDivElement | null>(null)
  /** dock 的实际宽度，用来算每一格的宽度（旋转屏幕/改字体都要重新量） */
  const [width, setWidth] = useState(0)
  /** 手指正指着哪一格（松手才真的切页） */
  const [hover, setHover] = useState<number | null>(null)
  /** 按住时整条玻璃轻微下沉，给一点按压反馈 */
  const [pressed, setPressed] = useState(false)
  const dragRef = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null)
  /** 上一次跨到的格子，避免同一个格子反复震动 */
  const lastRef = useRef<number | null>(null)
  /** 拖动结束后的那次 click 要忽略，否则会按回按下时的那一格 */
  const skipClickRef = useRef(false)

  const activeIndex = Math.max(0, items.findIndex((i) => i.key === active))
  const shown = hover ?? activeIndex
  const stride = items.length > 0 && width > 0 ? width / items.length : 0

  /* 量宽度：首帧 + 尺寸变化 */
  useLayoutEffect(() => {
    const el = dockRef.current
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const indexAt = useCallback(
    (clientX: number): number => {
      const el = dockRef.current
      if (!el || stride <= 0) return 0
      const rel = clientX - el.getBoundingClientRect().left
      return Math.min(items.length - 1, Math.max(0, Math.floor(rel / stride)))
    },
    [stride, items.length]
  )

  function releasePointer(pointerId: number): void {
    const el = dockRef.current
    if (!el) return
    try {
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    } catch {
      /* 指针已经没了 */
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    // 只认左键/单指触摸，右键和手柄键不参与
    if (e.button !== 0) return
    const el = dockRef.current
    if (!el) return
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, moved: false }
    skipClickRef.current = false
    setPressed(true)
    const index = indexAt(e.clientX)
    lastRef.current = index
    setHover(index)
    try {
      // 手指滑出 dock 也继续收到 move/up，不会半路丢掉
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 某些 WebView 不支持捕获，退化即可 */
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < DRAG_SLOP) return
      drag.moved = true
    }
    const index = indexAt(e.clientX)
    if (index !== lastRef.current) {
      lastRef.current = index
      tick()
    }
    setHover(index)
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    releasePointer(e.pointerId)
    setPressed(false)
    setHover(null)
    // 拖过之后浏览器还会补一次 click，丢掉它
    if (drag.moved) skipClickRef.current = true
    const item = items[indexAt(e.clientX)]
    if (item) onSelect(item.key)
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    // 手势被系统拿走了：回弹到原来那格，绝不提交
    dragRef.current = null
    releasePointer(e.pointerId)
    setPressed(false)
    setHover(null)
    lastRef.current = null
  }

  return (
    <div className="m-dock-wrap">
      <div className="m-dock">
        <div
          className={`m-dock-glass ${pressed ? 'is-pressed' : ''}`}
          ref={dockRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {/* 跟手滑动的液态药丸：按住时瞬间跟手，松手后用一条短缓动归位 */}
          <div
            className={`m-dock-pill ${hover !== null ? 'is-dragging' : ''}`}
            style={{
              width: stride > 0 ? stride - 12 : 0,
              left: 6,
              transform: `translateX(${stride > 0 ? shown * stride : 0}px)`
            }}
          />

          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              className={`m-dock-item ${shown === i ? 'm-dock-item-on' : ''}`}
              aria-current={i === activeIndex ? 'page' : undefined}
              // 键盘/无障碍走 click；触摸与拖动由上面的 pointer 事件负责
              onClick={() => {
                if (skipClickRef.current) {
                  skipClickRef.current = false
                  return
                }
                onSelect(it.key)
              }}
            >
              <span className="m-dock-icon">{it.icon}</span>
              <span className="m-dock-label">{it.label}</span>
            </button>
          ))}
        </div>

        {/* 右侧 1/4：圆形 + 号 */}
        <div className="m-dock-add">
          <motion.button
            type="button"
            className="m-fab"
            whileTap={{ scale: 0.94 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            onClick={onAdd}
            aria-label="添加任务"
          >
            {plusIcon}
          </motion.button>
        </div>
      </div>
    </div>
  )
}
