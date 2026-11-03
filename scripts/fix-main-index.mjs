/**
 * 一次性修复：main/index.ts 曾被 GBK 误解码往返，少量字符丢失。
 * 按行号精确重写受损行（从后往前替换，避免行号漂移）。
 * 运行： node scripts/fix-main-index.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/main/index.ts'
const lines = readFileSync(file, 'utf8').split(/\r?\n/)

// 行号(1-based) → 替换成的若干行
const fixes = {
  34: ['/* --------------------------- 命令行开关 --------------------------- */'],
  50: ['/** `--eval-file <path>`：截图前在渲染层执行一段脚本，用于端到端 UI 验证 */'],
  67: ['/** 大屏上的舒适上限：4K 下也不铺满，避免元素被拉得过大 */'],
  97: ['  // 默认不常驻：由用户在「设置」里主动开启', '  miniVisible: false,'],
  124: ['    /* 状态保存失败不应影响运行 */'],
  154: [
    '  // 而是通过 CDP 覆盖视口来模拟目标分辨率，见 shot 分支。',
    '  if (state.width > 0 && state.height > 0 && state.x !== undefined) {'
  ],
  173: ['/** 右下角：贴着工作区右下放置，自动避开任务栏 */'],
  186: ['/* --------------------------- 主窗口 --------------------------- */'],
  260: [
    '              // 用 CDP 覆盖视口：真实模拟 1080p~4K，不受物理屏幕尺寸钳制',
    "              mainWindow!.webContents.debugger.attach('1.3')"
  ],
  305: ['/* --------------------------- 右下角常驻小窗 --------------------------- */'],
  374: ['/** 统一的 IPC 结果包装：业务异常不抛出，改为结构化返回，避免渲染层拿到裸 Error */'],
  395: ['/* 日格任务：语义与旧版 MCP 的 items_* 对齐 */'],
  416: ['/* 事件：语义与旧版 MCP 的 events_* 对齐 */'],
  451: ['  // 令牌留空表示「不修改」，避免用户只改地址时把令牌清掉'],
  458: [
    "  if (!cfg) return { ok: false, pushed: 0, pulled: 0, tables: {}, error: '尚未配置同步地址或令牌' }"
  ],
  527: ['/** 系统主题：跟随操作系统 / 强制浅色 / 强制深色 */'],
  540: ['/** 探测旧版「日历清单」的 MCP 桥程序 */'],
  559: [
    '  // 无界面同步一次（用于自动化验证或计划任务）',
    "  if (process.argv.includes('--sync-once')) {"
  ],
  560: ["    console.log('[caldesk] sync-once: 开始')"],
  565: ["      console.error('[caldesk] 缺少同步配置（--sync-url / --sync-token 或 sync.json）')"],
  580: [
    '  // 主题来源必须在建窗之前设好，否则首帧会闪一次错误配色',
    "  nativeTheme.themeSource = themeArg === 'light' || themeArg === 'dark' ? themeArg : state.themeMode"
  ],
  593: [
    '  // 自动同步：启动后跑一次，之后每 5 分钟一次（仅在配置了同步时）',
    '  const autoSync = (): void => {'
  ],
  610: ['  // 本地 MCP / CLI 服务：随机回环端口，供 agent 与命令行访问'],
  614: ["      if (!cfg) return { ok: false, error: '尚未配置同步地址或令牌' }"],
  633: ["        return { ok: false, error: 'from / to 必须是 YYYY-MM-DD' }"]
}

const indexes = Object.keys(fixes)
  .map(Number)
  .sort((a, b) => b - a)

let applied = 0
for (const idx of indexes) {
  const at = idx - 1
  if (at < 0 || at >= lines.length) {
    console.error(`行号越界: ${idx}`)
    continue
  }
  lines.splice(at, 1, ...fixes[idx])
  applied += 1
}

writeFileSync(file, lines.join('\n'), 'utf8')

const remaining = lines.filter((l) => l.includes('\uFFFD')).length
console.log(`已修复 ${applied} 处，剩余含非法字符的行: ${remaining}`)
if (remaining > 0) {
  lines.forEach((l, i) => {
    if (l.includes('\uFFFD')) console.log(`  ${i + 1}: ${l.trim()}`)
  })
}
