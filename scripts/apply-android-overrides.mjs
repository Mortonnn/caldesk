/**
 * 把 `mobile-native/android/` 里的手工改动同步进 `android/`。
 *
 * 为什么需要这一步：
 *   `android/` 是 `npx cap add android` 生成的整个工程，被 `.gitignore` 忽略
 *   （重新生成应该是干净的）。但里面有几处**必须由人维护**的改动，重新生成会丢：
 *
 *     1. `MainActivity.java` 的返回键接线（不加的话弹层开着按返回会直接退出 App）
 *
 *   把这几处放进 `mobile-native/android/`（镜像 android/ 的目录结构），跟着版本库走，
 *   生成完跑一次本脚本即可。`cap sync` 不会覆盖这些文件，只有 `cap add` 会。
 *
 * 做法：递归复制 `mobile-native/android/**` → `android/**`，内容相同就跳过，不删除多余文件。
 *
 * 用法：
 *   node scripts/apply-android-overrides.mjs            # 应用
 *   node scripts/apply-android-overrides.mjs --check    # 只检查是否已一致（CI 用，不一致退出码 1）
 *
 * 前置：先跑过 `npx cap add android`（`android/` 不存在时给提示并退出 2）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'mobile-native/android')
const TARGET = join(root, 'android')
const checkOnly = process.argv.includes('--check')

if (!existsSync(TARGET)) {
  console.error('找不到 android/ 目录。先跑：npx cap add android')
  process.exit(2)
}
if (!existsSync(SOURCE)) {
  console.error(`找不到 ${SOURCE}，仓库不完整？`)
  process.exit(2)
}

/** 递归列出目录下所有文件 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(SOURCE)
let copied = 0
let same = 0
/** --check 模式下「不一致」的数量。它和 copied 必须分开算：
 *  以前 --check 分支在累加 copied 之前就 continue 了，导致 copied 永远是 0，
 *  于是「不一致就 exit 1」这道闸从来没生效过。 */
let drift = 0

for (const src of files) {
  const rel = relative(SOURCE, src)
  const dst = join(TARGET, rel)
  if (existsSync(dst) && readFileSync(dst).equals(readFileSync(src))) {
    same += 1
    console.log(`  相同  ${rel}`)
    continue
  }
  if (checkOnly) {
    drift += 1
    console.error(`  不一致 ${rel}`)
    continue
  }
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  copied += 1
  console.log(`  写入  ${rel}`)
}

console.log(
  checkOnly
    ? `\n${files.length} 个文件：已一致 ${same}，不一致 ${drift}`
    : `\n${files.length} 个文件：写入 ${copied}，已一致 ${same}`
)
if (checkOnly && drift > 0) {
  console.error('android/ 与 mobile-native/ 不一致，请跑 node scripts/apply-android-overrides.mjs')
  process.exit(1)
}
if (!checkOnly && copied > 0) {
  console.log('下一步：cd android && .\\gradlew.bat assembleDebug')
}
