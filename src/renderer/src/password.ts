/**
 * 强密码生成：数字、大写、小写、符号各至少一个，长度 16。
 *
 * 用 crypto.getRandomValues，不用 Math.random —— 这是要交给用户当账号密码的。
 * 排除容易看错的字符（0/O、1/l/I），复制粘贴和手抄都少出错。
 */
const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%^&*-_=+?'

function randomInt(max: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % max
}

export function generateStrongPassword(length = 16): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[randomInt(set.length)])
  while (chars.length < length) chars.push(all[randomInt(all.length)])
  // 打乱，避免前四位永远是"小写大写数字符号"
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    const tmp = chars[i]
    chars[i] = chars[j]
    chars[j] = tmp
  }
  return chars.join('')
}
