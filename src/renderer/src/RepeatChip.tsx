/**
 * 一行待办左侧的「重复」按钮。
 *
 * 平时显示当前重复规则（默认「不重复」），点开是一张列表：
 * 不重复 / 每天 / 每周 / 每月 / 每年 / 每 N 天。
 * 选「每 N 天」时在菜单里直接填数字，规则写成 FREQ=DAILY;INTERVAL=N。
 *
 * 为什么做成按钮而不是下拉框：下拉框在每行里会把行高撑开、又不显示当前值，
 * 这个小胶囊只占一行文字的高度，规则变化一眼能看到。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { describeRrule, toDayNumber, weekdayOf } from '@shared/rrule'

const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

type Preset = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'

const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: 'none', label: '不重复' },
  { key: 'daily', label: '每天' },
  { key: 'weekly', label: '每周' },
  { key: 'monthly', label: '每月' },
  { key: 'yearly', label: '每年' },
  { key: 'custom', label: '每 N 天' }
]

/** 把预设翻成 iCal 规则；none 返回 null */
function toRule(preset: Preset, baseDate: string, days: number): string | null {
  switch (preset) {
    case 'none':
      return null
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${BYDAY[weekdayOf(toDayNumber(baseDate))]}`
    case 'monthly':
      return 'FREQ=MONTHLY'
    case 'yearly':
      return 'FREQ=YEARLY'
    case 'custom':
      return `FREQ=DAILY;INTERVAL=${Math.max(1, Math.min(365, Math.round(days)))}`
  }
}

export function RepeatChip({
  rule,
  baseDate,
  onChange
}: {
  rule: string | null
  baseDate: string
  onChange: (next: string | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /**
   * 「每 N 天」里的数字。
   *
   * 必须存成字符串：存数字的话，一删空就 `Number('') = 0`，
   * 再 `|| 1` 补成 1，光标停在 1 后面 —— 用户想打 2 就变成 12、想打 5 变成 15，
   * 只能挪光标去删前面那个 1。所以编辑期间允许空串，失焦/应用时再收敛。
   */
  const [daysText, setDaysText] = useState('3')
  /** 收敛后的合法值：1..365 */
  const days = Math.max(1, Math.min(365, Math.round(Number(daysText) || 1)))
  /**
   * 菜单位置。默认**向上**弹：这个按钮永远在窗口/弹层底部，
   * 往下弹就直接出屏、点都点不到（之前就是这么坏的）。
   * 只有上方真的没空间（比如输入框在屏幕最顶端）才退回往下。
   */
  const [pos, setPos] = useState<{
    top?: number
    bottom?: number
    left: number
    origin: string
  } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 菜单是 portal 到 body 上的，不在按钮的 DOM 子树里，得单独记一份 */
  const menuRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const r = boxRef.current?.getBoundingClientRect()
    if (!r) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 菜单大概 6 项高；只用来判断上方够不够放
    const guess = 240
    const above = r.top >= guess
    // 左边别贴边：夹在 [8, 视口宽 - 菜单宽 - 8]
    const left = Math.max(8, Math.min(r.left, vw - 208))
    setPos(
      above
        ? { bottom: vh - r.top + 8, left, origin: 'bottom left' }
        : { top: r.bottom + 8, left, origin: 'top left' }
    )
  }, [open])

  /* 点外面关掉；但下面几种"看起来像外面"的情况不能关：
     - 键盘弹起会让 WebView 改变尺寸并触发 resize/scroll，
       如果这时把菜单关掉，用户刚点进"每 N 天"的输入框就被夺走了；
     - 焦点还在菜单里时同理。 */
  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const focusInsideMenu = (): boolean =>
      Boolean(menuRef.current && menuRef.current.contains(document.activeElement))
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      // 菜单在 body 上，不能只判断按钮：不然点菜单本身会被当成"点外面"先关掉，
      // pointerdown 一关，后面的 click 就永远不来了 —— 表现就是"点了没反应"。
      if (boxRef.current?.contains(t) || menuRef.current?.contains(t)) return
      close()
    }
    const onScrollOrResize = (): void => {
      if (focusInsideMenu()) return
      close()
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  const label = describeRrule(rule)
  const repeat = Boolean(rule)

  function pick(preset: Preset): void {
    onChange(toRule(preset, baseDate, days))
    setOpen(false)
  }

  return (
    <div className="repeat-chip-box" ref={boxRef}>
      <button
        type="button"
        className={`repeat-chip ${repeat ? 'is-on' : ''} ${open ? 'is-open' : ''}`}
        /* 关键：不要抢走输入框的焦点。按钮默认会在 pointerdown 时 blur 输入框，
           安卓上键盘立刻收起，用户得点两下才能继续输入。 */
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="重复规则"
      >
        {label}
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            className="repeat-menu"
            role="menu"
            ref={menuRef}
            style={{
              position: 'fixed',
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              zIndex: 120,
              // 从按钮那一角长出来，像是从胶囊里"抽"出这张单子
              transformOrigin: pos.origin
            }}
          >
            {PRESETS.map((p, i) =>
              p.key === 'custom' ? (
                // 自定义这一行不能整个做成 button：输入框套在按钮里，
                // 聚焦输入框会被按钮当成"激活"，键盘一开一关就没法编辑了。
                <div
                  key={p.key}
                  className="repeat-item is-custom"
                  style={{ animationDelay: `${i * 24}ms` }}
                >
                  <button
                    type="button"
                    className="repeat-custom-go"
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => pick('custom')}
                  >
                    每 N 天
                  </button>
                  <input
                    className="repeat-days"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={3}
                    value={daysText}
                    /* 点进去就全选：想改成 5 直接打，不用先删 */
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDaysText(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    /* 失焦时才收敛成合法数字，编辑过程中允许空 */
                    onBlur={() => setDaysText(String(days))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') pick('custom')
                    }}
                  />
                </div>
              ) : (
                <button
                  key={p.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={p.key === 'none' ? !repeat : false}
                  className="repeat-item"
                  style={{ animationDelay: `${i * 24}ms` }}
                  /* 别把焦点从输入框上抢走，否则安卓键盘会收起、要再点一次 */
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pick(p.key)}
                >
                  {p.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
