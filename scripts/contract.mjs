/**
 * 前端契约检查（重构期间的重命名保险丝）。
 *
 * 仓库里有 90+ 条 .preview/*.mjs 探针脚本按类名、文本、自定义属性名断言界面，
 * 其中 [aria-label="设置"] 还被主进程生产代码（src/main/index.ts --open-settings）直接 querySelector。
 * 因此「视觉重写」不能顺手改这些名字。这个脚本把这份契约固化下来：
 * 任何一次改动只要动了下面这些名字，`npm run test:contract` 立刻红。
 *
 * 纯静态检查（读源码，不启动 app），所以可以在 CI / 提交前跑。
 *
 *   node scripts/contract.mjs
 *   node scripts/contract.mjs --verbose
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const R = (p) => resolve(ROOT, p)
const verbose = process.argv.includes('--verbose')

/** 读文件；不存在直接抛，避免"文件改名了但检查静默跳过" */
function read(rel) {
  const p = R(rel)
  if (!existsSync(p)) throw new Error(`缺少文件：${rel}`)
  return readFileSync(p, 'utf8')
}

/**
 * 桌面端界面的源码文本 = `App.tsx` + `app/**` 下所有 .ts/.tsx。
 *
 * `App.tsx` 原本是 2186 行的单组件，后来按状态归属拆成了
 * `app/use*.ts` + `app/*.tsx`。契约断言关心的是「这些类名 / aria 在桌面端存在」，
 * 不是「它们必须都在同一个文件里」，所以这里把目录也递归读进来。
 */
function readDesktopSources() {
  const parts = [read('src/renderer/src/App.tsx')]
  const dir = 'src/renderer/src/app'
  const walk = (rel) => {
    for (const name of readdirSync(R(rel))) {
      const childRel = `${rel}/${name}`
      if (statSync(R(childRel)).isDirectory()) walk(childRel)
      else if (name.endsWith('.tsx') || name.endsWith('.ts')) parts.push(read(childRel))
    }
  }
  if (existsSync(R(dir))) walk(dir)
  return parts.join('\n')
}

const DESKTOP_CSS = read('src/renderer/src/styles.css')
const MOBILE_CSS = read('src/renderer/src/mobile.css')
const MINI_CSS = read('src/renderer/src/mini.css')
const TOKENS_CSS = read('src/renderer/src/tokens.css')
const DESKTOP_TSX = readDesktopSources()
const MOBILE_TSX = read('src/renderer/src/MobileApp.tsx')
const MINI_TSX = read('src/renderer/src/mini.tsx')
const MAIN_TS = read('src/main/index.ts')
/** 共享组件：重复规则芯片 / 手机底栏 / 手机登录页 */
const CHIP_TSX = read('src/renderer/src/RepeatChip.tsx')
const DOCK_TSX = read('src/renderer/src/GlassDock.tsx')
const MSETUP_TSX = read('src/renderer/src/MobileSetup.tsx')

/** 全局失败计数 */
let failures = 0
let passes = 0

function check(label, ok, detail) {
  if (ok) {
    passes += 1
    if (verbose) console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
}

/** 断言某个 CSS 文件里存在一个选择器（按字面片段匹配，容忍格式化差异） */
function cssHas(css, selector, file) {
  // 把换行、逗号后的空格、多余空白压成单空格，再按片段找
  const flat = css.replace(/\s+/g, ' ')
  check(`${file} 选择器 ${selector}`, flat.includes(selector), `在 ${file} 里找不到「${selector}」`)
}

/** 断言 TSX 里出现过某个 className 片段 */
function tsxHas(src, cls, file) {
  check(`${file} 类名 ${cls}`, src.includes(cls), `在 ${file} 里找不到「${cls}」`)
}

/** 断言源码里出现过某段文本 */
function srcHas(src, text, file) {
  check(`${file} 文本 ${JSON.stringify(text)}`, src.includes(text), `在 ${file} 里找不到这段文本`)
}

/** 断言某个自定义属性在 CSS 里被定义 */
function tokenHas(css, name) {
  check(`自定义属性 ${name}`, new RegExp(`${name}\\s*:`).test(css), `${name} 没有定义`)
}

console.log('\n== 1. 桌面端结构选择器 ==')
// 月历
for (const s of [
  '.grid-stage',
  '.grid',
  '.cell',
  '.cell.outside',
  '.cell.selected',
  '.daynum',
  '.daynum.today',
  '.cell-body',
  '.cell-lines',
  '.cell-events',
  '.cell-more',
  '.cell-row-probe',
  '.line',
  '.ev',
  '.ev-dot',
  '.grid-head',
  '.grid-head-cell'
]) {
  cssHas(DESKTOP_CSS, s, 'styles.css')
}
// 侧栏
for (const s of [
  '.sidebar',
  '.month-nav',
  '.month-label',
  '.cal-list',
  '.cal-item',
  '.cal-dot',
  '.cal-name',
  '.cal-current',
  '.cal-del',
  '.cal-new',
  '.cal-input',
  '.cal-error',
  '.sidebar-foot'
]) {
  cssHas(DESKTOP_CSS, s, 'styles.css')
}
// 详情
for (const s of [
  '.detail',
  '.detail-stage',
  '.detail-main',
  '.detail-body',
  '.detail-resizer',
  '.task-row',
  '.task-row.done',
  '.task-label',
  '.task-text',
  '.checkbox',
  '.checkbox.checked',
  '.task-del',
  '.task-add-row',
  '.task-input',
  '.ev-meta',
  '.empty'
]) {
  cssHas(DESKTOP_CSS, s, 'styles.css')
}
// 面板 / 设置 / 弹层
for (const s of [
  '.panel',
  '.panel-scrim',
  '.panel-head',
  '.panel-body',
  '.panel-actions',
  '.set-block',
  '.set-body',
  '.seg-group',
  '.seg-item',
  '.switch',
  '.switch-knob',
  '.snap-row',
  '.snap-label',
  '.snap-meta',
  '.snap-more',
  '.note-item',
  '.note-title',
  '.note-preview',
  '.note-editor',
  '.note-text',
  '.note-actions',
  '.primary-btn',
  '.ghost',
  '.result-row',
  '.result-title',
  '.ev-kind',
  '.confirm-backdrop',
  '.confirm-card',
  '.confirm-actions',
  '.net-chip',
  '.scrim',
  '.titlebar',
  '.titlebar-drag',
  '.titlebar-tools',
  '.tool-btn',
  '.caption-btn',
  '.caption-buttons',
  '.brand',
  '.brand-mark',
  '.menu-btn',
  '.sidebar-toggle',
  '.hint'
]) {
  cssHas(DESKTOP_CSS, s, 'styles.css')
}
// 重复规则（桌面 + 手机共用同一套类名）
for (const s of ['.repeat-chip', '.repeat-chip-box', '.repeat-menu', '.repeat-item', '.repeat-days', '.repeat-custom-go']) {
  cssHas(DESKTOP_CSS, s, 'styles.css')
  cssHas(MOBILE_CSS, s, 'mobile.css')
}

console.log('\n== 2. 手机端结构选择器 ==')
for (const s of [
  '.m-shell',
  '.m-top',
  '.m-top-title',
  '.m-brand',
  '.m-top-month',
  '.m-cal-btn',
  '.m-offline',
  '.m-menu',
  '.m-menu-item',
  '.m-body',
  '.m-view',
  '.m-pane',
  '.m-pager',
  '.m-track',
  '.m-grid',
  '.m-grid-cell',
  '.m-grid-num',
  '.m-grid-dots',
  '.m-grid-dot',
  '.m-grid-today',
  '.m-grid-selected',
  '.m-dow-row',
  '.m-day',
  '.m-day-head',
  '.m-day-title',
  '.m-today-btn',
  '.m-section',
  '.m-card',
  '.m-list',
  '.m-group',
  '.m-group-date',
  '.m-group-item',
  '.m-group-main',
  '.m-group-title',
  '.m-group-sub',
  '.m-group-done',
  '.m-event-bar',
  '.m-task',
  '.m-task-check',
  '.m-task-check-on',
  '.m-task-text',
  '.m-task-label',
  '.m-task-tag',
  '.m-task-del',
  '.m-empty',
  '.m-load-error',
  '.m-dock-wrap',
  '.m-dock',
  '.m-dock-glass',
  '.m-dock-lens',
  '.m-dock-lens-glow',
  '.m-dock-item',
  '.m-dock-item-on',
  '.m-dock-icon',
  '.m-dock-label',
  '.m-dock-add',
  '.m-fab',
  '.m-sheet',
  '.m-sheet-mask',
  '.m-sheet-handle',
  '.m-sheet-title',
  '.m-sheet-input',
  '.m-sheet-add-row',
  '.m-sheet-actions',
  '.m-confirm',
  '.m-confirm-mask',
  '.m-confirm-title',
  '.m-confirm-text',
  '.m-confirm-actions',
  '.m-toast',
  '.m-setup',
  '.m-setup-input',
  '.m-setup-btn',
  '.m-auth-tabs',
  '.m-auth-tab',
  '.m-auth-link',
  '.m-set-row',
  '.m-set-input',
  '.m-side-btn',
  '.m-btn',
  '.m-btn-primary',
  '.m-btn-danger',
  '.swipe-row',
  '.swipe-content',
  '.swipe-del'
]) {
  cssHas(MOBILE_CSS, s, 'mobile.css')
}

console.log('\n== 3. 状态类与伪元素契约 ==')
check('styles.css 有 .cell::before（check-tokens/check-reduced 断言其 transition）', /\.cell::before/.test(DESKTOP_CSS))
check('styles.css 有 .cell:hover .cal-del 之类 hover 显隐', /\.cal-item:hover \.cal-del/.test(DESKTOP_CSS))
check('mobile.css 有 .m-task-label::after（3 条脚本读它的 transform）', /\.m-task-label::after/.test(MOBILE_CSS))
check('styles.css 有 .task-label::after（桌面删除线）', /\.task-label::after/.test(DESKTOP_CSS))
check('mobile.css 声明 overscroll 行为', /overscroll-behavior/.test(MOBILE_CSS))

console.log('\n== 4. TSX 类名与 aria 契约 ==')
for (const c of [
  'task-row',
  'task-label',
  'task-text',
  'checkbox',
  'task-del',
  'cell-body',
  'cell-lines',
  'cell-row-probe',
  'task-add-row',
  'cal-item',
  'detail-body',
  'confirm-backdrop',
  'confirm-card',
  'net-chip'
]) {
  tsxHas(DESKTOP_TSX, c, 'App.tsx')
}
tsxHas(CHIP_TSX, 'repeat-chip', 'RepeatChip.tsx')
tsxHas(CHIP_TSX, 'repeat-menu', 'RepeatChip.tsx')
tsxHas(CHIP_TSX, 'repeat-item', 'RepeatChip.tsx')
for (const c of ['m-dock', 'm-dock-lens', 'm-fab', 'm-dock-item', 'm-dock-glass']) {
  tsxHas(DOCK_TSX, c, 'GlassDock.tsx')
}
tsxHas(MSETUP_TSX, 'm-setup-input', 'MobileSetup.tsx')
for (const c of [
  'm-shell',
  'm-top',
  'm-body',
  'm-pane',
  'm-grid-cell',
  'm-grid-selected',
  'm-task',
  'm-task-check',
  'm-task-label',
  'm-task-tag',
  'm-task-del',
  'm-card',
  'm-sheet',
  'm-confirm'
]) {
  tsxHas(MOBILE_TSX, c, 'MobileApp.tsx')
}

// aria-label / title：其中 [aria-label="设置"] 被生产代码硬编码，不能改
for (const a of ['aria-label="设置"', 'aria-label="便签"', 'aria-label="搜索"', 'title="设置"']) {
  srcHas(DESKTOP_TSX, a, 'App.tsx')
}
srcHas(MAIN_TS, '[aria-label="设置"]', 'src/main/index.ts')

console.log('\n== 5. 自定义属性契约（脚本按名读取） ==')
for (const t of ['--spring-droplet', '--m-t-fast', '--m-t-page', '--m-t-pop', '--m-t-enter', '--m-ease-pop-out']) {
  tokenHas(MOBILE_CSS + TOKENS_CSS, t)
}

console.log('\n== 6. 文案契约（脚本按 === 比对） ==')
// 重复规则菜单的两端共用 RepeatChip，文案在它里面，不在 App.tsx
for (const s of ['每天', '每周', '不重复']) {
  srcHas(CHIP_TSX, s, 'RepeatChip.tsx')
}
for (const s of ['取消', '仅删除', '删除整个', '添加', '新日历名称', '要做什么？']) {
  srcHas(MOBILE_TSX, s, 'MobileApp.tsx')
}
for (const s of ['今天没有任务和日程', '打开日历']) {
  srcHas(MINI_TSX, s, 'mini.tsx')
}

console.log('\n== 7. 浮窗 ==')
for (const s of [
  '.mini',
  '.mini-head',
  '.mini-title',
  '.mini-actions',
  '.mini-btn',
  '.mini-list',
  '.mini-task-row',
  '.mini-check',
  '.mini-task-text',
  '.mini-cal-dot',
  '.mini-sep',
  '.mini-foot',
  '.mini-open',
  '.mini-empty'
]) {
  cssHas(MINI_CSS, s, 'mini.css')
}
check('mini.html 保留 body.mini-body', read('src/renderer/mini.html').includes('class="mini-body"'))

console.log('\n== 8. 入口文件 ==')
for (const [f, script] of [
  ['src/renderer/index.html', '/src/main.tsx'],
  ['src/renderer/mini.html', '/src/mini.tsx'],
  ['src/renderer/mobile.html', '/src/mobile.tsx']
]) {
  const html = read(f)
  check(`${f} 有 #root`, html.includes('id="root"'))
  check(`${f} 入口是 ${script}`, html.includes(script))
  check(`${f} 有 CSP`, html.includes('Content-Security-Policy'))
}

console.log(`\n${failures === 0 ? '✔' : '✘'} 契约检查：${passes} 通过 / ${failures} 失败\n`)
if (failures > 0) process.exit(1)
