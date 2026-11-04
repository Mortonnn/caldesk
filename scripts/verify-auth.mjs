/**
 * 账号密码协议的端到端验收。
 *
 *   # 本地：先起 worker
 *   cd worker && npx wrangler dev --local --port 8787
 *   # 再跑
 *   node scripts/verify-auth.mjs http://127.0.0.1:8787 dev-invite-123
 *
 *   # 线上：服务器设了 INSTANCE_INVITE 就把邀请码作为第二个参数
 *   node scripts/verify-auth.mjs https://your-worker.workers.dev <邀请码>
 *
 * 覆盖：注册 / 邀请码 / 用户名唯一 / 弱密码 / 错密码 / 同一账号第二台设备登录 /
 *      同账号共享数据 / 设备名上报 / 退出登录。
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const INVITE = process.argv[3] ?? ''

const hex = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const post = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {})
    },
    body: JSON.stringify(body ?? {})
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const get = async (path, token, headers = {}) => {
  const res = await fetch(BASE + path, {
    headers: token ? { authorization: token, ...headers } : headers
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name} ${extra}`)
  }
}

const user = `t_${Date.now().toString(36)}`
const pw = 'Abcdef123!x'
const devA = { id: crypto.randomUUID(), secret: hex(32) }
const devB = { id: crypto.randomUUID(), secret: hex(32) }
const tokenA = `Bearer ${devA.id}.${devA.secret}`
const tokenB = `Bearer ${devB.id}.${devB.secret}`

const reg = await post('/auth/register', {
  username: user,
  password: pw,
  deviceId: devA.id,
  secret: devA.secret,
  deviceName: 'Morton-laptop_110415',
  invite: INVITE
})
check('注册成功', reg.status === 200 && reg.body?.accountId, JSON.stringify(reg))
const accountId = reg.body?.accountId

if (INVITE) {
  const noInvite = await post('/auth/register', {
    username: `${user}_x`,
    password: pw,
    deviceId: crypto.randomUUID(),
    secret: hex(32)
  })
  check('无邀请码被拒', noInvite.status === 403, JSON.stringify(noInvite))
}

const dup = await post('/auth/register', {
  username: user.toUpperCase(),
  password: pw,
  deviceId: crypto.randomUUID(),
  secret: hex(32),
  invite: INVITE
})
check('用户名大小写重名被拒', dup.status === 409, JSON.stringify(dup))

const weak = await post('/auth/register', {
  username: `${user}_weak`,
  password: 'abcdefgh',
  deviceId: crypto.randomUUID(),
  secret: hex(32),
  invite: INVITE
})
check('弱密码被拒', weak.status === 400, JSON.stringify(weak))

const badLogin = await post('/auth/login', {
  username: user,
  password: 'WrongPass123!',
  deviceId: devB.id,
  secret: devB.secret,
  deviceName: 'Xiaomi15_110415'
})
check('错密码 401', badLogin.status === 401, JSON.stringify(badLogin))

const login = await post('/auth/login', {
  username: user,
  password: pw,
  deviceId: devB.id,
  secret: devB.secret,
  deviceName: 'Xiaomi15_110415'
})
check('第二台设备登录成功', login.status === 200 && login.body?.accountId === accountId, JSON.stringify(login))

const me = await get('/auth/me', tokenA)
check('me 返回用户名', me.body?.username === user, JSON.stringify(me))

const push = await post(
  '/sync/push',
  {
    table: 'calendars',
    rows: [
      {
        id: 'cal_test_1',
        updatedAt: Date.now(),
        deletedAt: null,
        payload: JSON.stringify({ id: 'cal_test_1', name: '共享日历', color: '#2f6bff' })
      }
    ]
  },
  tokenA
)
check('A 推送成功', push.status === 200, JSON.stringify(push))

await new Promise((r) => setTimeout(r, 300))
const pull = await get('/sync/pull?table=calendars&since=0', tokenB)
const rows = pull.body?.rows ?? []
check('B 能看到 A 的数据', rows.some((r) => r.id === 'cal_test_1'), JSON.stringify(pull.body).slice(0, 200))

await get('/devices', tokenA, { 'x-device-name': 'Morton-laptop_110415' })
const devices = await get('/devices', tokenA)
const list = devices.body?.devices ?? []
check(
  '设备名按上报更新',
  list.some((d) => d.name === 'Morton-laptop_110415'),
  JSON.stringify(list)
)

const logout = await post('/auth/logout', {}, tokenB)
check('退出登录', logout.status === 200, JSON.stringify(logout))
const meAfter = await get('/auth/me', tokenB)
check('退出后凭据失效', meAfter.status === 401, JSON.stringify(meAfter))
const meA2 = await get('/auth/me', tokenA)
check('另一台设备不受影响', meA2.status === 200, JSON.stringify(meA2))

console.log(`\n通过 ${pass} / ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
