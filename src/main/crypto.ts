/**
 * 端到端加密：同步行的 payload 在离开本机之前就被加密。
 *
 * 算法：AES-256-GCM，密钥 = 账号密钥（32 字节，只在设备之间流传）。
 * 存储格式：base64( iv(12) || ciphertext || tag(16) )。
 *
 * 服务端只认识这串 base64，既解不开也看不出内容；
 * 它仍然需要 tbl / id / updated_at 来做增量与 LWW，所以这些字段保持明文。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LEN = 12

export function newAccountKey(): string {
  return randomBytes(32).toString('base64')
}

export function newDeviceSecret(): string {
  return randomBytes(32).toString('hex')
}

export function encryptPayload(plain: string, accountKeyB64: string): string {
  const key = Buffer.from(accountKeyB64, 'base64')
  if (key.length !== 32) throw new Error('账号密钥长度不对')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, body, tag]).toString('base64')
}

export function decryptPayload(blob: string, accountKeyB64: string): string {
  const key = Buffer.from(accountKeyB64, 'base64')
  if (key.length !== 32) throw new Error('账号密钥长度不对')
  const buf = Buffer.from(blob, 'base64')
  if (buf.length <= IV_LEN + 16) throw new Error('密文太短')
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(buf.length - 16)
  const body = buf.subarray(IV_LEN, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}
