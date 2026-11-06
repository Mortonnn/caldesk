/**
 * 动效令牌（桌面端；手机端在 mobile.css 里用同名 CSS 变量镜像一套）。
 *
 * 数值来自 FlClash 开源项目（`lib/ui/navigation_dock.dart`、`lib/ui/page_transition.dart`），
 * 它是 Flutter 写的，弹簧用 `SpringDescription` 描述，这里换算成 framer-motion 的 spring：
 *   damping = 2 * ratio * sqrt(stiffness * mass)
 *
 *   droplet  165 / .80  → stiffness 165 damping 20.5   勾选、轻提示、列表重排
 *   press    311 / .59  → stiffness 311 damping 20.9   按压回弹
 *   travel   400ms bounce .15 → 247 / .85              松手吸附、弹层进出
 *   settle   500ms bounce .32 → 158 / .68              落定（允许 5% 过冲）
 *
 * 曲线仍然保留三条，只给"透明度/颜色"这类不好用弹簧的属性用：
 *   emphasized 位移、换页；out 只进不出；in 只出不进。
 * 时长：120 反馈 / 180 小件 / 240 面板 / 300 换页。
 */
import type { Transition, Variants } from 'framer-motion'

/** 位移、换页、展开 */
export const EASE_EMPHASIZED: [number, number, number, number] = [0.2, 0, 0, 1]
/** 只进不出：进场、松手归位 */
export const EASE_OUT: [number, number, number, number] = [0.05, 0.7, 0.1, 1]
/** 只出不进：退场 */
export const EASE_IN: [number, number, number, number] = [0.3, 0, 0.8, 0.15]

export const DUR = {
  /** 按压、悬停、勾选 */
  fast: 0.12,
  /** 菜单、提示、小面板 */
  base: 0.18,
  /** 侧栏、详情面板 */
  page: 0.24,
  /** 整层换页（含出场+进场） */
  screen: 0.3
} as const

/** 跟手的小东西：勾选、药丸、列表重排（FlClash droplet 165 / .8） */
export const DROPLET: Transition = { type: 'spring', stiffness: 165, damping: 20.5, mass: 1 }
/** 按压回弹（311 / .59）：按下去弹回来，几乎不过冲 */
export const PRESS: Transition = { type: 'spring', stiffness: 311, damping: 20.9, mass: 1 }
/** 弹层/面板进出（travel 400ms bounce .15）：起手快、末端收住 */
export const PANEL: Transition = { type: 'spring', stiffness: 247, damping: 26.7, mass: 1 }
/** 落定（settle 500ms bounce .32）：允许一点点过冲，用在需要"落位感"的地方 */
export const SETTLE: Transition = { type: 'spring', stiffness: 158, damping: 17.1, mass: 1 }

/**
 * 面板 / 弹层进场。
 *
 * 固定 12~20px 的位移，永远不要整屏飞；出场更短、更小，
 * 因为"消失"不需要被看清楚，只要不突兀（透明度用曲线，不用弹簧）。
 */
export const panelIn = (distance = 16): Variants => ({
  initial: { opacity: 0, x: distance },
  animate: { opacity: 1, x: 0, transition: PANEL },
  exit: { opacity: 0, x: distance * 0.5, transition: { duration: DUR.fast, ease: EASE_IN } }
})

export const riseIn = (distance = 8): Variants => ({
  initial: { opacity: 0, y: distance },
  animate: { opacity: 1, y: 0, transition: DROPLET },
  exit: { opacity: 0, y: -distance * 0.5, transition: { duration: DUR.fast, ease: EASE_IN } }
})

export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN } }
}
