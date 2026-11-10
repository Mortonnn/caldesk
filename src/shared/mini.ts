/**
 * 桌面浮窗（mini window）的公共契约。
 *
 * 主进程（窗口状态 / 尺寸）、渲染层设置面板（切换控件）、浮窗本体（范围渲染）
 * 三处必须用同一份定义，否则「设置里选了 1 周、浮窗却按天画」这类偏差
 * 只会在运行期才暴露。
 */

/** 浮窗显示范围：当天 / 今天起 8 天（到下个同星期几）/ 今天到下月同日 */
export type MiniRange = 'day' | 'week' | 'month'

/** 浮窗显示样式：列表（当前日程流）/ 月视图（整月网格） */
export type MiniView = 'list' | 'month'

/** 设置面板里的展示顺序：1天 → 1周 → 1月 */
export const MINI_RANGE_ORDER: readonly MiniRange[] = ['day', 'week', 'month']

export const MINI_RANGE_LABEL: Record<MiniRange, string> = {
  day: '1天',
  week: '1周',
  month: '1月'
}

/** 设置面板里的展示顺序：列表 → 月视图 */
export const MINI_VIEW_ORDER: readonly MiniView[] = ['list', 'month']

export const MINI_VIEW_LABEL: Record<MiniView, string> = {
  list: '列表',
  month: '月视图'
}

/**
 * 浮窗尺寸预设。
 *
 * 浮窗本身仍可拖动边缘自由缩放；预设只是给「我现在就想把它变大」一个一键入口。
 * 宽高都凑成整十，且是让月视图 7 列 × 6 行的日格接近正方形：
 * 320×420 / 380×460 / 480×550（实测格子约 44×45 / 53×52 / 67×67）。
 */
export interface MiniSizePreset {
  id: 'compact' | 'standard' | 'roomy'
  label: string
  width: number
  height: number
}

export const MINI_SIZE_PRESETS: readonly MiniSizePreset[] = [
  { id: 'compact', label: '小', width: 320, height: 420 },
  { id: 'standard', label: '标准', width: 380, height: 460 },
  { id: 'roomy', label: '大', width: 480, height: 550 }
]

/**
 * 旧版三档尺寸。升级时把落在旧预设上的窗口尺寸迁移到新预设，
 * 否则老用户一启动就被判成「自定义」，设置里三档全不亮。
 */
export const LEGACY_MINI_SIZE_PRESETS = [
  { width: 320, height: 380 },
  { width: 380, height: 500 },
  { width: 480, height: 660 }
] as const

/** 默认 380×460：列表能放下 7~8 行，月视图的日格也接近正方形。 */
export const DEFAULT_MINI_WIDTH = 380
export const DEFAULT_MINI_HEIGHT = 460

/** 自由缩放的硬边界（主进程还会按所在显示器工作区再收一次）。 */
export const MINI_MIN_WIDTH = 280
export const MINI_MIN_HEIGHT = 240
export const MINI_MAX_WIDTH = 760
export const MINI_MAX_HEIGHT = 1000

/** 贴边留白：和原 `MINI_MARGIN` 保持一致 */
export const MINI_MARGIN = 16

export function isMiniRange(value: unknown): value is MiniRange {
  return value === 'day' || value === 'week' || value === 'month'
}

export function isMiniView(value: unknown): value is MiniView {
  return value === 'list' || value === 'month'
}
