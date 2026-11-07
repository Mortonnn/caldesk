/**
 * 液态玻璃底栏 —— 按 FlClash 的 FloatingNavigationBar 重做。
 *
 * 之前那版是"一格一格跳的药丸"，被指着说不行。FlClash 的做法不是药丸，
 * 是一枚**跟着手指走的液态透镜**：
 *  - 透镜的位置是连续的（不是离散格子）：手指到哪，透镜贴到哪，松手才吸到目标格；
 *  - 移动时透镜会果冻式拉伸：速度快就横向拉长、纵向压扁，刹车时反向压一下；
 *  - 图标不是"选中/未选中"两种状态，而是按它离透镜中心的距离**渐进放大**（放大镜）；
 *  - 按下时透镜抬起一点、亮起一圈光晕，松手落下；
 *  - 跨格给一次 selectionClick 轻震。
 *
 * 参数出处（.tools/flclash/FlClash-main/lib/ui/navigation_dock.dart）：
 *  - _followSpring stiffness 1024 / damping 0.9：拖动时极跟手
 *  - _travelSpring 400ms / bounce 0.15：松手吸到目标格
 *  - _jellyStretch 0.2 / _jellySquash 0.15 / _jellyAspect 1.4：果冻
 *  - _lensMagnify 0.16：图标在透镜里最多放大 16%
 *  - _liftSpring 250ms：按下抬起
 *
 * 为什么用 rAF + ref 直接写 style：CSS 过渡表达不了"每帧换目标的物理弹簧"，
 * 而每帧 setState 会重渲染整棵月历。这里只动透镜和 3 个图标的 transform，
 * 全部走合成层，不触发 React 重渲染。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface DockItem {
  key: string
  label: string
  icon: React.ReactNode
}

/** 手指移动超过这个距离才算拖动（Flutter kTouchSlop） */
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

function tick(): void {
  try {
    navigator.vibrate?.(8)
  } catch {
    /* 不支持就算了 */
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** 临界阻尼弹簧的一步积分：把 current 拉向 target，返回新的 (值, 速度) */
function springStep(
  value: number,
  velocity: number,
  target: number,
  stiffness: number,
  damping: number,
  dt: number
): [number, number] {
  const a = stiffness * (target - value) - damping * velocity
  const nv = velocity + a * dt
  return [value + nv * dt, nv]
}

export function GlassDock({
  items,
  active,
  hidden,
  onSelect,
  onAdd
}: {
  items: DockItem[]
  active: string
  hidden?: boolean
  onSelect: (key: string) => void
  onAdd: () => void
}): React.JSX.Element {
  const dockRef = useRef<HTMLDivElement | null>(null)
  const lensRef = useRef<HTMLDivElement | null>(null)
  const iconRefs = useRef<Array<HTMLSpanElement | null>>([])
  const [width, setWidth] = useState(0)
  /** 手指/透镜当前悬在哪一格（松手才提交） */
  const [hover, setHover] = useState<number | null>(null)
  const [pressed, setPressed] = useState(false)

  const activeIndex = Math.max(0, items.findIndex((i) => i.key === active))
  const count = items.length
  const stride = count > 0 && width > 0 ? width / count : 0
  const shown = hover ?? activeIndex

  /**
   * 动画状态全放 ref：位置（格为单位的连续值）、速度、抬起量、果冻量。
   * target 由手指/选中态改，rAF 每帧把 value 拉过去并写进 DOM。
   */
  const anim = useRef({
    pos: 0,
    vel: 0,
    target: 0,
    lift: 0,
    liftVel: 0,
    liftTarget: 0,
    jelly: 0,
    jellyVel: 0,
    jellyTarget: 0
  })
  /** 拖动时目标跟着手指连续变；true 表示不用弹簧、直接贴手 */
  const draggingRef = useRef(false)
  const dragRef = useRef<{ pointerId: number; startX: number; moved: boolean } | null>(null)
  const lastRef = useRef<number | null>(null)
  const skipClickRef = useRef(false)
  const rafRef = useRef<number | null>(null)

  /* 量宽度 */
  useLayoutEffect(() => {
    const el = dockRef.current
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 把动画状态写进 DOM：透镜位置/果冻，图标按离透镜中心距离放大 */
  const paint = useCallback((): void => {
    const lens = lensRef.current
    const a = anim.current
    if (!lens || stride <= 0) return
    const cx = (a.pos + 0.5) * stride // 透镜中心（px）
    const stretch = clamp(a.jelly, -0.15, 0.2)
    // FlClash: lensWidth=(w+growth)*(1+stretch), lensHeight=(h+growth)*(1-stretch*1.4)
    // 静止时留 8px inset，像 iOS tab bar 的 resting lens 那样"浮"在格子里
    const growth = 8 * 2 * a.lift
    const inset = 8
    lens.style.width = `${(stride - inset * 2 + growth) * (1 + stretch)}px`
    // 透镜是"一整块玻璃"，图标和下面的文字都在里面（MIUI 底栏就是这个形态）。
    // 56 是底栏高度，减 10 留出上下各 5px 的呼吸；按下时再长大 8px。
    lens.style.height = `${(56 - 10 + growth) * (1 - stretch * 1.4)}px`
    lens.style.transform = `translate3d(${cx}px, -50%, 0) translateX(-50%)`
    // 静止也要是一块看得见的选中玻璃；按下抬起时更亮一点
    lens.style.opacity = String(0.92 + 0.08 * a.lift)

    // 图标放大镜：离透镜中心越近，放大越多；抬起时才生效
    const reach = stride * 0.9
    for (let i = 0; i < count; i += 1) {
      const icon = iconRefs.current[i]
      if (!icon) continue
      const itemCx = (i + 0.5) * stride
      const near = Math.max(0, 1 - Math.abs(itemCx - cx) / reach)
      const scale = 1 + 0.16 * a.lift * near
      icon.style.transform = `scale(${scale.toFixed(3)})`
      icon.style.color = near > 0.62 && a.lift > 0.15 ? 'var(--m-accent)' : ''
    }
  }, [stride, count])

  /** 每帧推进三个弹簧，直到都停下 */
  const loop = useCallback((): void => {
    const a = anim.current
    const dt = 1 / 60
    if (draggingRef.current) {
      // 拖动：位置直接贴手指，抬起快速到 1，果冻由速度驱动
      a.pos = a.target
      ;[a.lift, a.liftVel] = springStep(a.lift, a.liftVel, a.liftTarget, 311, 24, dt)
      const speed = Math.abs(a.vel)
      a.jellyTarget = 0.2 * Math.min(1, speed / 3) // _jellyStretch * saturate(speed/_jellySpeed)
      ;[a.jelly, a.jellyVel] = springStep(a.jelly, a.jellyVel, a.jellyTarget, 100, 16, dt)
    } else {
      // 松手：travel 弹簧吸到目标格，落下，果冻归零带回弹
      ;[a.pos, a.vel] = springStep(a.pos, a.vel, a.target, 1024, 61, dt)
      ;[a.lift, a.liftVel] = springStep(a.lift, a.liftVel, 0, 180, 22, dt)
      ;[a.jelly, a.jellyVel] = springStep(a.jelly, a.jellyVel, 0, 100, 13, dt)
    }
    paint()

    const settled =
      !draggingRef.current &&
      Math.abs(a.pos - a.target) < 0.002 &&
      Math.abs(a.vel) < 0.01 &&
      Math.abs(a.lift) < 0.005 &&
      Math.abs(a.jelly) < 0.003
    if (settled) {
      a.pos = a.target
      a.lift = 0
      a.jelly = 0
      paint()
      rafRef.current = null
      return
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [paint])

  const kick = useCallback((): void => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(loop)
  }, [loop])

  /** 选中项或尺寸变了：透镜目标跟着变 */
  useEffect(() => {
    anim.current.target = shown
    if (anim.current.pos === 0 && anim.current.vel === 0) anim.current.pos = shown
    kick()
  }, [shown, kick])

  /** 量到宽度后（或旋转屏幕改变了宽度）立刻重画一次：
      静止状态没有 rAF 在跑，不主动 paint 透镜就是 0×0，什么都看不见 */
  useEffect(() => {
    if (stride > 0) paint()
  }, [stride, paint])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const indexAt = useCallback(
    (clientX: number): number => {
      const el = dockRef.current
      if (!el || stride <= 0) return 0
      const rel = clientX - el.getBoundingClientRect().left
      return clamp(Math.floor(rel / stride), 0, count - 1)
    },
    [stride, count]
  )

  /** 连续位置（格为单位，含小数），让透镜贴着手指走 */
  const positionAt = useCallback(
    (clientX: number): number => {
      const el = dockRef.current
      if (!el || stride <= 0) return 0
      const rel = clientX - el.getBoundingClientRect().left
      return clamp(rel / stride - 0.5, -0.35, count - 0.65)
    },
    [stride, count]
  )

  function releasePointer(pointerId: number): void {
    const el = dockRef.current
    if (!el) return
    try {
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    } catch {
      /* 已经释放 */
    }
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    const el = dockRef.current
    if (!el) return
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, moved: false }
    skipClickRef.current = false
    draggingRef.current = true
    const a = anim.current
    a.liftTarget = 1 // 抬起透镜
    a.pos = positionAt(e.clientX)
    a.target = a.pos
    a.vel = 0
    const index = indexAt(e.clientX)
    lastRef.current = index
    setHover(index)
    setPressed(true)
    kick()
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* 退化 */
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < DRAG_SLOP) return
      drag.moved = true
    }
    const a = anim.current
    const next = positionAt(e.clientX)
    // 速度（格/秒）用来驱动果冻拉伸
    a.vel = (next - a.target) * 60
    a.target = next
    const index = indexAt(e.clientX)
    if (index !== lastRef.current) {
      lastRef.current = index
      tick()
    }
    setHover(index)
    paint()
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    releasePointer(e.pointerId)
    draggingRef.current = false
    const a = anim.current
    a.liftTarget = 0
    a.target = indexAt(e.clientX) // 吸到手指下那一格
    a.vel = 0
    if (drag.moved) skipClickRef.current = true
    setPressed(false)
    setHover(null)
    const item = items[indexAt(e.clientX)]
    if (item) onSelect(item.key)
    kick()
  }

  function onPointerCancel(e: React.PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    releasePointer(e.pointerId)
    draggingRef.current = false
    const a = anim.current
    a.liftTarget = 0
    a.target = activeIndex // 系统抢走手势：回弹到原格，不提交
    a.vel = 0
    setPressed(false)
    setHover(null)
    lastRef.current = null
    kick()
  }

  return (
    <div className={`m-dock-wrap ${hidden ? 'is-hidden' : ''}`} aria-hidden={hidden}>
      <div className="m-dock">
        <div
          className={`m-dock-glass ${pressed ? 'is-pressed' : ''}`}
          ref={dockRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          {/* 液态玻璃透镜：连续跟手、果冻拉伸、内高光 */}
          <div className="m-dock-lens" ref={lensRef}>
            <span className="m-dock-lens-glow" />
          </div>

          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              className={`m-dock-item ${shown === i ? 'm-dock-item-on' : ''}`}
              aria-current={i === activeIndex ? 'page' : undefined}
              onClick={() => {
                if (skipClickRef.current) {
                  skipClickRef.current = false
                  return
                }
                onSelect(it.key)
              }}
            >
              <span
                className="m-dock-icon"
                ref={(el) => {
                  iconRefs.current[i] = el
                }}
              >
                {it.icon}
              </span>
              <span className="m-dock-label">{it.label}</span>
            </button>
          ))}
        </div>

        <div className="m-dock-add">
          <button type="button" className="m-fab" onClick={onAdd} aria-label="添加任务">
            {plusIcon}
          </button>
        </div>
      </div>
    </div>
  )
}
