/**
 * 分块上传大文件到 GitHub Release 资产（断点续传）。
 * 126MB 的安装包一次性 POST 会被连接重置，分块最稳。
 *
 * 用法：node scripts/upload-release-asset.mjs <releaseId> <文件路径> [资产名]
 */
import { createReadStream, statSync } from 'node:fs'
import { open } from 'node:fs/promises'

const [releaseId, filePath, assetName] = process.argv.slice(2)
const name = assetName ?? filePath.split(/[\\/]/).pop()
const size = statSync(filePath).size

const { execFile } = await import('node:child_process')
const token = await new Promise((resolve, reject) => {
  const p = execFile('git', ['credential', 'fill'], (err, stdout) => {
    if (err) return reject(err)
    const m = stdout.match(/password=(.*)/)
    resolve(m ? m[1].trim() : '')
  })
  p.stdin.write('protocol=https\nhost=github.com\n\n')
  p.stdin.end()
})
if (!token) throw new Error('拿不到 GitHub token')

const CHUNK = 8 * 1024 * 1024
const url = `https://uploads.github.com/repos/Mortonnn/caldesk/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
const fh = await open(filePath, 'r')
const buf = Buffer.alloc(CHUNK)

let uploaded = 0
let assetId = null
let assetUrl = null
while (uploaded < size) {
  const want = Math.min(CHUNK, size - uploaded)
  const { bytesRead } = await fh.read(buf, 0, want, uploaded)
  const part = buf.subarray(0, bytesRead)
  const end = uploaded + bytesRead - 1
  // 分块上传：第一块 POST 建资产，后续块 PUT 续传
  const target = assetId ? assetUrl : url
  const method = assetId ? 'PUT' : 'POST'
  const res = await fetch(target, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/octet-stream',
      'content-range': `bytes ${uploaded}-${end}/${size}`
    },
    body: part
  })
  const text = await res.text()
  if (!res.ok && res.status !== 422) {
    console.error(`分块 ${uploaded}-${end} 失败：${res.status} ${text.slice(0, 300)}`)
    process.exit(1)
  }
  uploaded = end + 1
  const pct = ((uploaded / size) * 100).toFixed(1)
  console.log(`已传 ${uploaded}/${size} (${pct}%) status=${res.status}`)
  if (text.trim().startsWith('{')) {
    const j = JSON.parse(text)
    if (j.id) {
      assetId = j.id
      // 续传端点：uploads 域名下的资产端点（api 域名只管元数据）
      assetUrl = `https://uploads.github.com/repos/Mortonnn/caldesk/releases/assets/${j.id}`
    }
    if (j.size === size) {
      console.log(`完成：${j.name} ${j.size} ${j.state}`)
      break
    }
  }
}
await fh.close()
