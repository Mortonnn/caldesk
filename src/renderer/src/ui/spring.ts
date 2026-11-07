/**
 * 弹簧引擎（rAF 逐帧积分）。
 *
 * 为什么不用 CSS：CSS 过渡表达不了"每帧换目标的物理弹簧"，
 * 而每帧 setState 会把整棵月历重渲染一遍。这里只往 DOM 写 transform / width，
 * 全部走合成层，不触发 React 重渲染。
 *
 * 参数换算（和 tokens.css 同一套语义：阻尼比 ζ + 响应时间 τ）：
 *   ω0 = 2π / τ;  k = ω0² · m;  c = 2ζ · ω0 · m        （m = 1）
 *   ζ ≥ 1 是临界/过阻尼（不振荡），ζ < 1 会过冲。
 */

export interface SpringConfig {
  stiffness: number
  damping: number
}

/** ζ / τ → 弹簧常数 */
export function springFrom(zeta: number, response: number, mass = 1): SpringConfig {
  const omega = (2 * Math.PI) / response
  return { stiffness: omega * omega * mass, damping: 2 * zeta * omega * mass }
}

/** 空间位移：ζ=0.99 τ=380ms（MIUI 年历卡 setEase(-2, .99, .38)） */
export const SPATIAL = springFrom(0.99, 0.38)
/** 选择透镜的左右边缘：MIUI 底栏药丸 spring(0.7, 0.4) 与 spring(0.75, 0.5) */
export const EDGE_LEFT = springFrom(0.7, 0.4)
export const EDGE_RIGHT = springFrom(0.75, 0.5)
/** 小物件落位：ζ=0.86 τ=260ms */
export const POP = springFrom(0.86, 0.26)
/** 按压回弹：FlClash stiffness 311 / damping 0.593 → 压缩到 240ms 的手感 */
export const PRESS = springFrom(0.593, 0.24)

/** 临界阻尼的一步积分。dt 用真实时间戳算，不用固定 1/60（高刷屏会快一倍） */
export function step(
  value: number,
  velocity: number,
  target: number,
  cfg: SpringConfig,
  dt: number
): [number, number] {
  const a = cfg.stiffness * (target - value) - cfg.damping * velocity
  const nextVelocity = velocity + a * dt
  return [value + nextVelocity * dt, nextVelocity]
}

export interface SpringState {
  value: number
  velocity: number
}

export function restAt(value: number): SpringState {
  return { value, velocity: 0 }
}

/**
 * 一帧推进一组弹簧，返回是否还在动。
 * 阈值取得比像素小一个量级，保证停下来时没有任何残影。
 */
export function advance(
  states: SpringState[],
  targets: number[],
  cfg: SpringConfig,
  dt: number,
  epsilon = 0.02
): boolean {
  let moving = false
  for (let i = 0; i < states.length; i += 1) {
    const s = states[i]
    const [v, vel] = step(s.value, s.velocity, targets[i], cfg, dt)
    s.value = v
    s.velocity = vel
    if (Math.abs(targets[i] - v) > epsilon || Math.abs(vel) > epsilon * 20) moving = true
  }
  return moving
}

/** 用户是否要求减少动效。每帧读一次 matchMedia 太贵，缓存结果并监听变化。 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 精细指针（有 hover）才跑指针高光 */
export function hasFinePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
}
