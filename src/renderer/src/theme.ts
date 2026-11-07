import { data } from './data'
/**
 * 主题模式：跟随系统 / 浅色 / 深色。
 *
 * 真正的切换由主进程的 nativeTheme.themeSource 完成，
 * 渲染层只通过 prefers-color-scheme 感知，因此无需在页面里改样式。
 */

export type ThemeMode = 'system' | 'light' | 'dark'

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

export const THEME_ORDER: ThemeMode[] = ['system', 'light', 'dark']

export async function getThemeMode(): Promise<ThemeMode> {
  return data.theme.getMode()
}

export async function setThemeMode(mode: ThemeMode): Promise<ThemeMode> {
  return data.theme.setMode(mode)
}
