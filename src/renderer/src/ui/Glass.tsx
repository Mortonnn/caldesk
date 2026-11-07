/**
 * 材质原件：环境层、指针高光。
 *
 * 环境层是**一个**静态元素（整窗唯一一层柔光 + 颗粒），指针高光把一帧内的多次
 * pointermove 合并成一次 CSS 变量写入 —— 这两处是最容易写成性能灾难的地方。
 *
 * 选择态的"透镜"不在这里：桌面端的月历透镜由 CSS 自定义属性驱动（见 styles.css），
 * 手机端底栏的透镜需要跟手指连续移动，走 Dock 里的 rAF 弹簧（见 mobile/Dock.tsx）。
 */
import { useCallback, useEffect, useRef } from 'react'
import { hasFinePointer, prefersReducedMotion } from './spring'

/** 环境层：整窗唯一的一层柔光 + 颗粒。玻璃能"看起来是玻璃"全靠这一层有东西可透。 */
export function Ambient({ className = '' }: { className?: string }): React.JSX.Element {
  return <div className={`mat-ambient ${className}`} aria-hidden="true" />
}

/**
 * 指针高光。
 *
 * 只做两件事：把相对元素中心的偏移换算成百分比（限幅 ±35%，再远高光就"脱开"面了），
 * 一帧只写一次 CSS 变量。粗指针 / 减少动效时整个 hook 空转。
 */
export function useSheen<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>
  handlers: {
    onPointerMove: (e: React.PointerEvent<T>) => void
    onPointerEnter: (e: React.PointerEvent<T>) => void
    onPointerLeave: () => void
  }
} {
  const ref = useRef<T | null>(null)
  const raf = useRef<number | null>(null)
  const box = useRef<DOMRect | null>(null)
  const pos = useRef({ x: 0, y: 0 })
  const enabled = useRef(false)

  useEffect(() => {
    enabled.current = hasFinePointer() && !prefersReducedMotion()
  }, [])

  const flush = useCallback((): void => {
    raf.current = null
    const el = ref.current
    if (!el) return
    el.style.setProperty('--mx', `${(50 + pos.current.x * 70).toFixed(1)}%`)
    el.style.setProperty('--my', `${(50 + pos.current.y * 70).toFixed(1)}%`)
    el.dataset.lit = '1'
  }, [])

  const onPointerEnter = useCallback((e: React.PointerEvent<T>): void => {
    if (!enabled.current) return
    box.current = e.currentTarget.getBoundingClientRect()
  }, [])

  const onPointerMove = useCallback(
    (e: React.PointerEvent<T>): void => {
      if (!enabled.current) return
      const r = box.current ?? e.currentTarget.getBoundingClientRect()
      box.current = r
      if (!r.width || !r.height) return
      pos.current = {
        x: Math.max(-0.5, Math.min(0.5, (e.clientX - r.left) / r.width - 0.5)),
        y: Math.max(-0.5, Math.min(0.5, (e.clientY - r.top) / r.height - 0.5))
      }
      if (raf.current === null) raf.current = requestAnimationFrame(flush)
    },
    [flush]
  )

  const onPointerLeave = useCallback((): void => {
    box.current = null
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
    const el = ref.current
    if (el) delete el.dataset.lit
  }, [])

  return { ref, handlers: { onPointerMove, onPointerEnter, onPointerLeave } }
}
