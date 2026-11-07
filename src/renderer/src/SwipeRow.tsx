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
import { useCallback, useEffect, useRef, useState } from 'react'
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
  /**
   * true = 这次删除会先弹确认框（重复待办）。
   *
   * 这种行不能播"滑出+收起"：确认框一弹出来，行已经从列表里消失了一半，
   * 用户点「取消」的话它就卡在透明状态里 —— 看不见，但还占着一行的高度，
   * 列表上面就豁出一个洞。所以拦下来的删除只给一次轻反馈，别动布局。
   */
  hold?: boolean
}

export function SwipeRow({
  children,
  onDelete,
  className = '',
  style,
  hold = false
}: SwipeRowProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [dx, setDx] = useState(0)
  /** 松手后的过渡：归位或滑出，跟手时关掉 */
  const [settling, setSettling] = useState(false)
  const [leaving, setLeaving] = useState(false)
  /**
   * 收起时的高度。
   *
   * null = 按内容自然撑开；数字 = 显式高度（先量出实际高度，下一帧改成 0，
   * 这样 height 才有起点可过渡，行是"塌下去"而不是"凭空消失"）。
   */
  const [collapse, setCollapse] = useState<number | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; axis: 'x' | 'y' | null } | null>(null)
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const width = (): number => wrapRef.current?.clientWidth ?? 320

  /** 滑出 → 塌下去 → 交给外部删数据；万一外部没删（取消/失败），到点自己弹回来 */
  const playLeave = useCallback(() => {
    setSettling(true)
    setDx(-width())
    setLeaving(true)
    const h = wrapRef.current?.offsetHeight ?? 0
    setCollapse(h)
    requestAnimationFrame(() => setCollapse(0))
    window.setTimeout(onDelete, 160)
    // 兜底：行还活着就说明没删成，别让它一直隐身占位
    if (restoreTimer.current) clearTimeout(restoreTimer.current)
    restoreTimer.current = setTimeout(() => {
      setLeaving(false)
      setCollapse(null)
      setDx(0)
      setSettling(false)
    }, 900)
  }, [onDelete])

  useEffect(
    () => () => {
      if (restoreTimer.current) clearTimeout(restoreTimer.current)
    },
    []
  )

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
      if (dx < -w * COMMIT) {
        if (hold) {
          // 会弹确认框：把行弹回去，等用户在框里做决定
          setSettling(true)
          setDx(0)
          onDelete()
          return
        }
        playLeave()
      } else {
        setSettling(true)
        setDx(0)
      }
    },
    [dx, hold, onDelete, playLeave]
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
      style={{
        ...style,
        ...(collapse === null ? null : { height: collapse, overflow: 'hidden' }),
        transition: collapse === null ? undefined : 'height 200ms cubic-bezier(0.22, 1, 0.36, 1)'
      }}
    >
      {/* 圆形红底 X：行被推开才露出来，不做整条红矩形 */}
      <button
        type="button"
        className="swipe-del"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        aria-label="删除"
        onClick={() => {
          if (hold) {
            onDelete()
            return
          }
          playLeave()
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
