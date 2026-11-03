/**
 * 全应用共用的一套图标。
 *
 * 规则只有三条，界面才不会显得"图标是随手贴上去的"：
 *   1. 一套线稿：24 网格、1.6 描边、圆头圆角。窗口按钮例外，见下方 Win*。
 *   2. 尺寸交给 CSS（.icon 的 width/height），组件只给一个 18px 的默认值。
 *   3. 颜色一律 currentColor，跟着所在文字的角色走，图标自己不带颜色。
 *
 * 桌面端、手机端、桌面浮窗、配对页都从这里取，别再写字形字符（‹ › ✕ × ＋）。
 */
import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Glyph({
  size = 18,
  children,
  ...rest
}: IconProps & { children: ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/* ------------------------------ 导航 ------------------------------ */

export const ChevronLeft = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Glyph>
)

export const ChevronRight = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M9.5 5.5 16 12l-6.5 6.5" />
  </Glyph>
)

export const ChevronDown = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M6 9.5 12 15l6-5.5" />
  </Glyph>
)

export const PanelLeft = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <rect x="3.2" y="4.2" width="17.6" height="15.6" rx="3" />
    <path d="M9.2 4.4v15.2" />
  </Glyph>
)

export const Menu = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Glyph>
)

/* ------------------------------ 动作 ------------------------------ */

export const Check = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M5 12.5 9.5 17 19 7" />
  </Glyph>
)

export const Plus = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
)

export const X = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
  </Glyph>
)

export const Trash = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5.2c0-.66.54-1.2 1.2-1.2h3.6c.66 0 1.2.54 1.2 1.2V7" />
    <path d="M6.4 7l.8 11.1c.05.72.65 1.28 1.37 1.28h6.86c.72 0 1.32-.56 1.37-1.28L17.6 7" />
    <path d="M10.3 11v4.6M13.7 11v4.6" />
  </Glyph>
)

/* ------------------------------ 对象 ------------------------------ */

export const Search = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="M15.4 15.4 20 20" />
  </Glyph>
)

export const Note = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M6 3.6h7.4L19 9.2v11.2H6z" />
    <path d="M13.2 3.8v5.6H19" />
    <path d="M9.2 13h6.2M9.2 16.4h4.2" />
  </Glyph>
)

export const Settings = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.1 14.2a1.5 1.5 0 0 0 .3 1.66l.06.06a1.82 1.82 0 1 1-2.58 2.58l-.06-.06a1.5 1.5 0 0 0-1.66-.3 1.5 1.5 0 0 0-.9 1.37v.17a1.82 1.82 0 1 1-3.64 0v-.09a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.66.3l-.06.06a1.82 1.82 0 1 1-2.58-2.58l.06-.06a1.5 1.5 0 0 0 .3-1.66 1.5 1.5 0 0 0-1.37-.9h-.17a1.82 1.82 0 1 1 0-3.64h.09a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.66l-.06-.06a1.82 1.82 0 1 1 2.58-2.58l.06.06a1.5 1.5 0 0 0 1.66.3h.07a1.5 1.5 0 0 0 .9-1.37v-.17a1.82 1.82 0 1 1 3.64 0v.09a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.66-.3l.06-.06a1.82 1.82 0 1 1 2.58 2.58l-.06.06a1.5 1.5 0 0 0-.3 1.66v.07a1.5 1.5 0 0 0 1.37.9h.17a1.82 1.82 0 1 1 0 3.64h-.09a1.5 1.5 0 0 0-1.37.9Z" />
  </Glyph>
)

export const CalendarIcon = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <rect x="3.4" y="5.2" width="17.2" height="15.4" rx="3" />
    <path d="M8 3.4v3.6M16 3.4v3.6M3.4 10.2h17.2" />
  </Glyph>
)

export const Clock = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 7.4V12l3 1.9" />
  </Glyph>
)

export const Pin = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M9.6 3.6h4.8l-.6 4.6 2.7 2.7v1.6H7.5v-1.6l2.7-2.7z" />
    <path d="M12 12.5V20" />
  </Glyph>
)

export const Bell = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M6.4 10.2a5.6 5.6 0 0 1 11.2 0c0 4.2 1.2 5.6 1.2 5.6H5.2s1.2-1.4 1.2-5.6Z" />
    <path d="M10.2 19a2 2 0 0 0 3.6 0" />
  </Glyph>
)

export const Hourglass = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M7.4 3.8h9.2M7.4 20.2h9.2" />
    <path d="M8.2 3.8v2.6c0 3.4 3.8 4.2 3.8 5.6s-3.8 2.2-3.8 5.6v2.6" />
    <path d="M15.8 3.8v2.6c0 3.4-3.8 4.2-3.8 5.6s3.8 2.2 3.8 5.6v2.6" />
  </Glyph>
)

export const Repeat = (p: IconProps): React.JSX.Element => (
  <Glyph {...p}>
    <path d="M4.6 9.4A4.4 4.4 0 0 1 9 5.2h9.4" />
    <path d="M16 3l2.6 2.2L16 7.4" />
    <path d="M19.4 14.6A4.4 4.4 0 0 1 15 18.8H5.6" />
    <path d="M8 21l-2.6-2.2L8 16.6" />
  </Glyph>
)

/* ------------------------------ 窗口按钮 ------------------------------ */

/** 窗口按钮用更细的 1.1 描边、10px 网格，跟系统标题栏的视觉重量对齐 */
function CaptionGlyph({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 10 10"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const WinMinimize = (): React.JSX.Element => (
  <CaptionGlyph>
    <path d="M0.6 5h8.8" />
  </CaptionGlyph>
)

export const WinMaximize = (): React.JSX.Element => (
  <CaptionGlyph>
    <rect x="0.9" y="0.9" width="8.2" height="8.2" rx="1.2" />
  </CaptionGlyph>
)

export const WinRestore = (): React.JSX.Element => (
  <CaptionGlyph>
    <rect x="0.9" y="3.1" width="6" height="6" rx="1" />
    <path d="M3.1 3V1.9h5a1 1 0 0 1 1 1v5h-1.1" />
  </CaptionGlyph>
)

export const WinClose = (): React.JSX.Element => (
  <CaptionGlyph>
    <path d="M1.2 1.2 8.8 8.8M8.8 1.2 1.2 8.8" />
  </CaptionGlyph>
)

/* ------------------------------ 品牌标记 ------------------------------ */

/**
 * caldesk 的标记：四格窗（也读作月历），左上格填实。
 *
 * 与应用图标同形，所以标题栏、手机顶栏、配对页、安装包、启动器图标
 * 看起来是同一个东西 —— 应用内外不会出现两套身份。
 */
export function CalMark({ size = 18, ...rest }: IconProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <rect
        x="3.2"
        y="3.2"
        width="17.6"
        height="17.6"
        rx="4.4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path d="M3.4 10.4h17.2M10.4 3.4v17.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.6 3.2h2.8v7.2H3.2V7.6a4.4 4.4 0 0 1 4.4-4.4Z" fill="currentColor" />
    </svg>
  )
}

/**
 * 预渲染的一组常用图标，给按名字取用的地方（手机端底栏、列表行）用。
 * 需要换尺寸时由 CSS 覆盖 svg 的 width/height。
 */
export const Icon = {
  chevronLeft: <ChevronLeft />,
  chevronRight: <ChevronRight />,
  chevronDown: <ChevronDown />,
  check: <Check />,
  plus: <Plus />,
  x: <X />,
  trash: <Trash />,
  search: <Search />,
  note: <Note />,
  settings: <Settings />,
  calendar: <CalendarIcon />,
  clock: <Clock />,
  pin: <Pin />,
  bell: <Bell />,
  hourglass: <Hourglass />,
  repeat: <Repeat />
}
