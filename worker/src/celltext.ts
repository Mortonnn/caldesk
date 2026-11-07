/**
 * 日格文本 <-> 行 的转换工具 —— Worker 侧副本。
 *
 * 为什么是副本而不是直接 import 仓库根的 src/shared/types：
 * Cloudflare Workers Builds 的根目录设成 worker/，构建上下文里没有仓库根的
 * src/，跨目录 import 会让线上构建失败。本文件与桌面端那份实现保持一致
 * （改一边记得改另一边）。
 */

/** 整格文本按行拆开；空文本得到空数组 */
export function splitLines(text: string): string[] {
  if (!text) return []
  return text.split(/\r?\n/)
}

/** 该行是否已完成（Markdown 删除线 `~~...~~`） */
export function isDoneLine(line: string): boolean {
  return /^~~.*~~$/.test(line.trim())
}

/** 去掉删除线标记后的纯文本 */
export function lineText(line: string): string {
  return line.trim().replace(/^~~/, '').replace(/~~$/, '')
}

/** 标记 / 取消标记完成 */
export function markDone(line: string, done: boolean): string {
  const plain = lineText(line)
  return done ? `~~${plain}~~` : plain
}
