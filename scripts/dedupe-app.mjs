/** 去重：移除重复的 state 声明与重复的 requestRemoveEvent/skipOne 块 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'src/renderer/src/App.tsx'
const lines = readFileSync(file, 'utf8').split('\n')

// 1) 相邻重复的 state 两行
for (let i = 0; i < lines.length - 3; i += 1) {
  if (
    lines[i].includes('const [customRrule') &&
    lines[i + 1].includes('const [confirmDelete') &&
    lines[i + 2].includes('const [customRrule')
  ) {
    lines.splice(i + 2, 2)
    console.log('已删除重复 state 声明（行', i + 3, '）')
    break
  }
}

// 2) 第二份 requestRemoveEvent ... 到 removeEvent 之前
const starts = []
lines.forEach((l, i) => {
  if (l.includes('async function requestRemoveEvent')) starts.push(i)
})
if (starts.length > 1) {
  const start = starts[1]
  const end = lines.findIndex((l, i) => i > start && l.includes('async function removeEvent'))
  if (end > start) {
    lines.splice(start, end - start)
    console.log(`已删除重复函数块 ${start + 1}..${end}`)
  }
}

writeFileSync(file, lines.join('\n'), 'utf8')
console.log('剩余 requestRemoveEvent 数量:', lines.filter((l) => l.includes('async function requestRemoveEvent')).length)
