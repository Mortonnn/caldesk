/**
 * 可左滑删除的列表行（照小米笔记的行交互）。
 *
 * 交互：
 *  - 只认横向：竖向留给页面滚动（touch-action: pan-y）；
 *  - 拖过一小段才判定方向，避免点选时轻微抖动就滑开；
 *  - 往左拖露出一个**圆形红底 X**（不是整条红色矩形），拖过头有橡皮筋阻尼；
 *  - 松手：过 40% 就滑出并删除，否则弹回原位；
 *  - 点一下（没拖）仍然走原来的 onClick，不影响勾选。
 *
 * 两个坑：
 *  1. 不能在 pointerdown 就 setPointerCapture：捕获会把 click 重定向到容器，
 *     勾选框就点不动了。等确认横向拖动再捕获。
 *  2. 列表的 React key 不能用数组下标：删一行后下标前移，会把"正在滑出"的
 *     实例复用给别的行，状态（dx / opacity）跟着串到别的行上。
 */
import { useCallback, useRef, useState } from 'react'
import { X } from './icons'

/** 判定为横向拖动的最小位移 */
const SLOP = 8
/** 滑出删除的阈值（占行宽比例） */
const COMMIT = 0.4

export interface SwipeRowProps {
  children: React.ReactNode
  onDelete: () => void
  className?: string
  /** 进场错峰用：延迟由外部按行号算 */
  style?: React.CSSProperties
}

export function SwipeRow({
  children,
  onDelete,
  className = '',
  style
}: SwipeRowProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [dx, setDx] = useState(0)
  /** 松手后的过渡：归位或滑出，跟手时关掉 */
  const [settling, setSettling] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; axis: 'x' | 'y' | null } | null>(null)

  const width = (): number => wrapRef.current?.clientWidth ?? 320

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null }
    setSettling(false)
    // 见文件头坑 1：这里不能捕获指针
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const mx = e.clientX - d.x
    const my = e.clientY - d.y
    if (d.axis === null) {
      if (Math.abs(mx) < SLOP && Math.abs(my) < SLOP) return
      d.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
      if (d.axis === 'x') {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* 不支持就算了 */
        }
      }
    }
    if (d.axis !== 'x') return
    const w = width()
    // 只往左滑；往右给一点阻尼（像拉到头）
    const raw = mx < 0 ? mx : mx * 0.2
    const over = raw < -w ? -w + (raw + w) * 0.25 : raw
    setDx(Math.max(over, -w * 1.25))
  }, [])

  const finish = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      drag.current = null
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      } catch {
        /* 已经释放 */
      }
      if (d.axis !== 'x') {
        setDx(0)
        return
      }
      const w = width()
      setSettling(true)
      if (dx < -w * COMMIT) {
        setDx(-w)
        setLeaving(true)
        window.setTimeout(onDelete, 180)
      } else {
        setDx(0)
      }
    },
    [dx, onDelete]
  )

  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
    } catch {
      /* 已经释放 */
    }
    setSettling(true)
    setDx(0)
  }, [])

  const open = dx < -6
  return (
    <div
      className={`swipe-row ${open ? 'is-open' : ''} ${leaving ? 'is-leaving' : ''} ${className}`}
      ref={wrapRef}
      style={style}
    >
      {/* 圆形红底 X：行被推开才露出来，不做整条红矩形 */}
      <button
        type="button"
        className="swipe-del"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        aria-label="删除"
        onClick={() => {
          setSettling(true)
          setDx(-width())
          setLeaving(true)
          window.setTimeout(onDelete, 180)
        }}
      >
        <X />
      </button>
      <div
        className="swipe-content"
        style={{
          transform: `translate3d(${dx}px,0,0)`,
          transition: settling ? 'transform 240ms cubic-bezier(0.2, 0, 0, 1)' : 'none'
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={onPointerCancel}
      >
        {children}
      </div>
    </div>
  )
}
