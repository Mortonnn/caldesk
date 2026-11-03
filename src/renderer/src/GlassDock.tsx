/**
 * 液态玻璃底栏（FlClash 那种手感）。
 *
 * 布局：整条浮在屏幕底部，左边 3/4 是玻璃 dock（3 个图标），
 * 右边 1/4 是圆形的 + 号。
 *
 * 玻璃感来自三层叠加：
 *   1. backdrop-filter: blur + saturate —— 真的把背后的内容揉成一片；
 *   2. 半透明白/黑渐变 —— 给玻璃一点厚度；
 *   3. 内阴影 + 高光描边 —— 玻璃边缘的折射感。
 *
 * 跟手：手指在 dock 上按下/滑动时，选中的"液态药丸"跟着手指那一格滑过去，
 * 松手才真正切换页面 —— 滑过不松手不会乱跳。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, useSpring } from 'framer-motion'

export interface DockItem {
  key: string
  label: string
  icon: React.ReactNode
}

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
  const pressedRef = useRef(false)

  const activeIndex = Math.max(0, items.findIndex((i) => i.key === active))
  const shown = hover ?? activeIndex
  const stride = items.length > 0 && width > 0 ? width / items.length : 0

  const x = useSpring(0, { stiffness: 420, damping: 34, mass: 0.7 })

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

  /* 药丸跟着当前选中的格子走 */
  useEffect(() => {
    if (stride > 0) x.set(shown * stride)
  }, [shown, stride, x])

  const indexAt = useCallback(
    (clientX: number): number => {
      const el = dockRef.current
      if (!el || stride <= 0) return 0
      const rel = clientX - el.getBoundingClientRect().left
      return Math.min(items.length - 1, Math.max(0, Math.floor(rel / stride)))
    },
    [stride, items.length]
  )

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    pressedRef.current = true
    setHover(indexAt(e.clientX))
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!pressedRef.current) return
    setHover(indexAt(e.clientX))
  }

  function onPointerEnd(e: React.PointerEvent<HTMLDivElement>): void {
    if (!pressedRef.current) return
    pressedRef.current = false
    const i = indexAt(e.clientX)
    setHover(null)
    const item = items[i]
    if (item) onSelect(item.key)
  }

  return (
    <div className="m-dock-wrap">
      <div className="m-dock">
        <div
          className="m-dock-glass"
          ref={dockRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {/* 跟手滑动的液态药丸 */}
          <motion.div
            className="m-dock-pill"
            style={{ x, width: stride > 0 ? stride - 12 : 0, left: 6 }}
          />

          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              className={`m-dock-item ${shown === i ? 'm-dock-item-on' : ''}`}
              // 键盘/无障碍直接用 click 切页；触摸走上面的 pointer 事件
              onClick={() => onSelect(it.key)}
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
            whileTap={{ scale: 0.88 }}
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
