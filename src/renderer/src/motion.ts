/**
 * 动效令牌：一套曲线、三档时长、两种弹簧。
 *
 * 数值取自 FlClash（`lib/ui/motion.dart` / `page_transition.dart`）：
 *  - 换页用 Android 14 的 shared-axis：25% 位移 + 交叉淡入，450ms，
 *    曲线 easeInOutCubicEmphasized = cubic-bezier(0.05, 0.7, 0.1, 1)；
 *  - 标签页切换 220ms / easeInOut；
 *  - 跟手元素（底栏药丸）用 mass 1 / stiffness 165 / 阻尼比 0.8 的液滴弹簧。
 *
 * 为什么照着它抄：那套手感的特点是"起步快、收尾稳、几乎不过冲"。
 * 只用一条曲线加上足够的时长，界面就不会像弹球机。
 */
import type { Transition, Variants } from 'framer-motion'

/** easeInOutCubicEmphasized：位移与淡入共用 */
export const EASE_EMPHASIZED: [number, number, number, number] = [0.05, 0.7, 0.1, 1]
/** 只用于反馈（悬停、按压）：冲出去就不回来 */
export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]

export const DUR = {
  /** 悬停、按压、勾选 */
  fast: 0.14,
  /** 菜单、提示、标签切换 */
  base: 0.22,
  /** 侧栏、详情面板、弹层 */
  page: 0.32
} as const

/** 液滴弹簧：底栏药丸、勾选框这种要"跟手"的小东西 */
export const DROPLET: Transition = { type: 'spring', stiffness: 165, damping: 20.5, mass: 1 }
/** 面板进场：同样软，但收敛更快，不拖沓 */
export const PANEL: Transition = { type: 'spring', stiffness: 235, damping: 28, mass: 1 }

/** 面板 / 弹层进场：位移固定在 12~18px，永远不要整屏飞 */
export const panelIn = (distance = 16): Variants => ({
  initial: { opacity: 0, x: distance },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: distance * 0.6 }
})

export const riseIn = (distance = 8): Variants => ({
  initial: { opacity: 0, y: distance },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -distance * 0.5 }
})

export const fade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 }
}
