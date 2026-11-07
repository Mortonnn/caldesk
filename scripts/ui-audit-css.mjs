/**
 * 列出 styles.css 里每个选择器出现的行号与所在 @media 上下文，找出"重复定义"。
 *   node scripts/ui-audit-css.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lines = readFileSync(resolve(ROOT, 'src/renderer/src/styles.css'), 'utf8').split('\n')

const hits = new Map()
let media = null
let depth = 0
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  const trimmed = line.trim()
  if (/^@media/.test(trimmed)) {
    media = trimmed
    depth = 0
    continue
  }
  if (trimmed.includes('{')) {
    const selector = trimmed.split('{')[0].trim()
    if (selector && !selector.startsWith('@') && !selector.startsWith('/*') && !selector.startsWith('*')) {
      for (const part of selector.split(',')) {
        const s = part.trim()
        if (!s) continue
        if (!hits.has(s)) hits.set(s, [])
        hits.get(s).push({ line: i + 1, media })
      }
    }
  }
  if (media && trimmed === '}' && depth === 0) media = null
}

const dup = [...hits.entries()].filter(([, v]) => v.length > 1)
console.log(`有 ${dup.length} 个选择器出现了不止一次：\n`)
for (const [sel, v] of dup.sort((a, b) => b[1].length - a[1].length)) {
  const contexts = v.map((x) => `${x.line}${x.media ? ` [${x.media}]` : ''}`)
  console.log(`  ${sel.padEnd(22)} ×${v.length}   ${contexts.join('  ')}`)
}
