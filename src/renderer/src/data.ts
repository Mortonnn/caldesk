/**
 * 数据访问边界。
 *
 * 渲染层只认识 `data`，不直接碰宿主 API。宿主按优先级解析：
 *   1. window.caldesk —— Electron preload 注入的 IPC
 *   2. window.__CALDESK_HTTP__ —— Capacitor / 测试夹具注入的远端配置
 *   3. localStorage 里的同步配置 —— 浏览器直接打开时用
 *   4. 桩 —— 显式报错，而不是白屏
 */
import { decodeDeviceNameHeader, encodeDeviceNameHeader } from '@shared/identity'
import { DEFAULT_MINI_HEIGHT, DEFAULT_MINI_WIDTH, type MiniRange, type MiniView } from '@shared/mini'
import type {
  CalendarMeta,
  DayCell,
  EventInput,
  EventOccurrence,
  Note,
  NoteInput,
  RestoreResult,
  SearchHit,
  SnapshotMeta
} from '@shared/types'
import {
  DEFAULT_SERVER_URL,
  credentialLooksValid,
  ensureMobileIdentity,
  isMobilePaired,
  loadMobileIdentity,
  randomHex,
  randomUuid,
  saveMobileIdentity,
  type MobileIdentity
} from './mobileIdentity'

type HostApi = Window['caldesk']
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface HttpConfig {
  url: string
  /** 兼容旧配置：现在用设备凭据代替单一令牌 */
  token?: string
  deviceId?: string
  deviceSecret?: string
}

export interface DeviceListResult {
  devices: Array<{
    deviceId: string
    name: string
    status: string
    lastSeenAt: number | null
    lastIp: string | null
    current: boolean
  }>
  online: number
}

export interface SyncStateResult {
  serverUrl: string
  deviceId: string
  deviceName: string
  accountId: string
  username: string
  paired: boolean
  /** 换服务器导致本次被退出登录 */
  loggedOut?: boolean
}

/** 账号接口的返回：服务端可能给这台设备换了一把新钥匙 */
export interface AuthResult {
  accountId: string
  username: string
  deviceId?: string
  secret?: string
}

/** 把登录/注册的结果落到本地身份上（必要时换成本地新凭据） */
function applyAuthResult(id: MobileIdentity, res: AuthResult): void {
  id.accountId = res.accountId
  id.username = res.username
  if (res.deviceId && res.secret) {
    id.deviceId = res.deviceId
    id.deviceSecret = res.secret
  }
  // 名字始终用本地这份（型号_月日时），换凭据时别把旧名字带过去
  id.deviceName = id.deviceName || 'unknown'
}

const HOST_KEY = 'caldesk.http'

/**
 * HTTP 头里只能放 latin1。
 *
 * 设备名是用户自己起的，默认是「型号_月日时」（纯 ASCII）没事，
 * 可中文名会让 fetch 直接抛 "Failed to fetch" ——
 * 而浏览器不会告诉你是哪个头坏了，只剩一句没头没尾的报错。
 *
 * 这里把非 latin1 的字符换掉：中文名丢掉重音、其余变问号。
 * 服务端那边只拿它当显示名，少几个字不影响。
 */
/**
 * 设备名走请求头，头只能承载 latin1 —— 交给 shared 里的百分号编码。
 * （以前这里是「非 ASCII 换成 `?`」，中文机型名会变成 "????" 并被服务端存下来。）
 */
function headerSafeName(name: string): string {
  return encodeDeviceNameHeader(name)
}

/* ------------------------------ HTTP 适配器 ------------------------------ */

export function createHttpHost(cfg: HttpConfig): HostApi {
  /* 移动端也走「设备凭据」：localStorage 里存 identity.json 的等价物 */
  const mobile: MobileIdentity = ensureMobileIdentity({
    // 空配置不能把已有的地址擦掉，undefined 才是「保持原样」
    serverUrl: cfg.url || undefined,
    // 别用占位名覆盖本地已经迁移好的名字（型号_月日时）
    deviceName: undefined
  })

  /**
   * 服务器地址以身份里的为准：默认地址可能为空，
   * 登录成功后服务端返回的地址会写进身份。
   */
  const base = (): string => (mobile.serverUrl || cfg.url || '').replace(/\/$/, '')

  if (cfg.deviceId && cfg.deviceSecret && credentialLooksValid(cfg.deviceId, cfg.deviceSecret)) {
    mobile.deviceId = cfg.deviceId
    mobile.deviceSecret = cfg.deviceSecret
    saveMobileIdentity(mobile)
  }
  if (cfg.token && !mobile.deviceSecret) {
    // 旧版配置：只有一个全局令牌，凑一个设备身份出来（不严谨但兼容）
    mobile.deviceSecret = cfg.token
    mobile.deviceId = cfg.deviceId ?? randomUuid()
    saveMobileIdentity(mobile)
  }

  async function req<T>(path: string, init?: RequestInit): Promise<IpcResult<T>> {
    try {
      const res = await fetch(base() + path, {
        ...init,
        headers: {
          authorization: `Bearer ${mobile.deviceId}.${mobile.deviceSecret}`,
          'x-device-name': headerSafeName(mobile.deviceName),
          'content-type': 'application/json',
          ...(init?.headers ?? {})
        }
      })
      if (res.status === 401) return { ok: false, error: '设备未授权或已被撤销，请重新登录' }
      if (!res.ok) {
        const text = await res.text()
        return { ok: false, error: `${res.status}：${text.slice(0, 160)}` }
      }
      return { ok: true, data: (await res.json()) as T }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  const post = <T>(path: string, body: unknown): Promise<IpcResult<T>> =>
    req<T>(path, { method: 'POST', body: JSON.stringify(body) })

  const tokenOf = (): string => `Bearer ${mobile.deviceId}.${mobile.deviceSecret}`

  /** 账号接口：注册 / 登录 / 认领 / 退出；错误体里的中文说明直接透出 */
  async function authCall<T>(path: string, body: unknown, token?: string): Promise<IpcResult<T>> {
    // 地址为空时 fetch 会变成相对路径（打到 https://localhost），浏览器只报
    // "Failed to fetch"，看不出是没填地址。先拦下来给一句人话。
    if (!base()) {
      return { ok: false, error: '还没填服务器地址' }
    }
    try {
      const res = await fetch(base() + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: token } : {})
        },
        body: JSON.stringify(body ?? {})
      })
      if (!res.ok) {
        const text = await res.text()
        if (res.status === 404) {
          return { ok: false, error: '服务器版本太旧，还没有账号密码接口，先部署新版 Worker' }
        }
        let message = text.slice(0, 160)
        try {
          const parsed = JSON.parse(text) as { message?: string; error?: string }
          message = parsed.message || parsed.error || message
        } catch {
          /* 非 JSON 就用原文 */
        }
        return { ok: false, error: message }
      }
      return { ok: true, data: (await res.json()) as T }
    } catch (err) {
      // Failed to fetch 大多是地址写错 / 没网 / 证书不对，把地址带出来才查得动
      return { ok: false, error: `连不上 ${base()}（${(err as Error).message}）` }
    }
  }

  /** 远端行 → 本地 DayCell 形状 */
  const toCell = (calendarId: string, row: { date: string; text: string }): DayCell => ({
    id: `${calendarId}:${row.date}`,
    calendarId,
    date: row.date,
    text: row.text ?? '',
    color: null,
    updatedAt: Date.now(),
    deletedAt: null
  })

  return {
    ping: () => Promise.resolve({ ok: true, ts: Date.now() }),

    window: {
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
      isMaximized: () => Promise.resolve(false),
      onMaximizedChange: () => () => {}
    },

    settings: {
      get: () =>
        Promise.resolve({
          miniVisible: false,
          miniPinned: false,
          // 手机 / 浏览器没有桌面浮窗：给一份和桌面默认一致的镜像值，
          // 免得设置面板读到 undefined 把分段控件点成"全不选"
          miniRange: 'month' as MiniRange,
          miniView: 'list' as MiniView,
          miniWidth: DEFAULT_MINI_WIDTH,
          miniHeight: DEFAULT_MINI_HEIGHT,
          autoStart: false,
          closeToTray: false
        }),
      setAutoStart: () => Promise.resolve(false),
      setCloseToTray: () => Promise.resolve(false),
      setMiniRange: (range: MiniRange) => Promise.resolve(range),
      setMiniView: (view: MiniView) => Promise.resolve(view)
    },

    calendars: {
      list: () => req<CalendarMeta[]>('/api/calendars'),
      /**
       * 新建视图。
       *
       * 颜色由调用方给（和桌面用同一支色板挑"第一支没用过的"），
       * 服务端一次把新列表带回来，不再补 GET —— 手机上次操作慢一半就是多这一趟。
       */
      create: async (name: string, color?: string) => {
        const res = await post<{
          created?: CalendarMeta
          calendars?: CalendarMeta[]
        }>('/api/calendars/create', { name, color })
        if (!res.ok) return res as unknown as IpcResult<never>
        if (res.data.created && res.data.calendars) {
          return { ok: true as const, data: { created: res.data.created, calendars: res.data.calendars } }
        }
        // 老服务端只回一条：补一次列表
        const list = await req<CalendarMeta[]>('/api/calendars')
        if (!list.ok) return list as unknown as IpcResult<never>
        const created = (res.data.created ?? list.data.find((c) => c.name === name)) as CalendarMeta
        return { ok: true as const, data: { created, calendars: list.data } }
      },
      update: () => Promise.resolve({ ok: false as const, error: '移动端暂不支持重命名视图' }),
      remove: async (id: string) => {
        const res = await post<{ ok?: boolean; calendars?: CalendarMeta[] }>('/api/calendars/delete', {
          id
        })
        if (!res.ok) return res as unknown as IpcResult<never>
        if (res.data.calendars) return { ok: true as const, data: res.data.calendars }
        return req<CalendarMeta[]>('/api/calendars')
      }
    },

    cells: {
      range: async (calendarId: string, from: string, to: string) => {
        const res = await req<Array<{ date: string; text: string }>>(
          `/api/cells?calendar=${encodeURIComponent(calendarId)}&from=${from}&to=${to}`
        )
        return res.ok ? { ok: true as const, data: res.data.map((r) => toCell(calendarId, r)) } : (res as unknown as IpcResult<never>)
      },
      get: async (calendarId: string, date: string) => {
        const res = await req<Array<{ date: string; text: string }>>(
          `/api/cells?calendar=${encodeURIComponent(calendarId)}&from=${date}&to=${date}`
        )
        if (!res.ok) return res as unknown as IpcResult<never>
        const hit = res.data.find((r) => r.date === date)
        return { ok: true as const, data: toCell(calendarId, hit ?? { date, text: '' }) }
      },
      setText: async (calendarId: string, date: string, text: string) => {
        const res = await post<{ text: string }>('/api/cells/set', {
          calendar: calendarId,
          date,
          text
        })
        return res.ok
          ? { ok: true as const, data: toCell(calendarId, { date, text: res.data.text }) }
          : (res as unknown as IpcResult<never>)
      },
      appendLine: async (calendarId: string, date: string, text: string) => {
        const res = await post<{ text: string }>('/api/cells/append', { calendar: calendarId, date, text })
        return res.ok ? { ok: true as const, data: toCell(calendarId, { date, text: res.data.text }) } : (res as unknown as IpcResult<never>)
      },
      updateLine: () => Promise.resolve({ ok: false as const, error: '移动端暂不支持改行文本' }),
      deleteLine: async (calendarId: string, date: string, index: number) => {
        const res = await post<{ text: string }>('/api/cells/remove-line', { calendar: calendarId, date, index })
        return res.ok ? { ok: true as const, data: toCell(calendarId, { date, text: res.data.text }) } : (res as unknown as IpcResult<never>)
      },
      setDone: async (calendarId: string, date: string, index: number, done: boolean) => {
        const res = await post<{ text: string }>('/api/cells/toggle', { calendar: calendarId, date, index, done })
        return res.ok ? { ok: true as const, data: toCell(calendarId, { date, text: res.data.text }) } : (res as unknown as IpcResult<never>)
      }
    },

    events: {
      range: async (calendarId: string, from: string, to: string) => {
        const res = await req<Array<{ event: Record<string, unknown>; date: string; done: boolean }>>(
          `/api/events?calendar=${encodeURIComponent(calendarId)}&from=${from}&to=${to}`
        )
        if (!res.ok) return res as unknown as IpcResult<never>
        return { ok: true as const, data: res.data as unknown as EventOccurrence[] }
      },
      create: async (input: EventInput) => {
        const res = await post<{ id: string }>('/api/events/create', {
          calendar: input.calendarId,
          kind: input.kind,
          title: input.title,
          start: input.start,
          rrule: input.rrule ?? null,
          targetDate: input.targetDate ?? null
        })
        if (!res.ok) return res as unknown as IpcResult<never>
        return {
          ok: true as const,
          data: {
            id: res.data.id,
            calendarId: input.calendarId,
            kind: input.kind,
            title: input.title,
            start: input.start,
            rrule: input.rrule ?? null
          } as never
        }
      },
      update: () => Promise.resolve({ ok: false as const, error: '移动端暂不支持修改事件' }),
      remove: async (id: string) => {
        const res = await post<{ ok: boolean }>('/api/events/delete', { id })
        return res.ok ? { ok: true as const, data: true } : (res as unknown as IpcResult<never>)
      },
      setDone: async (eventId: string, date: string, done: boolean) => {
        const res = await post<{ ok: boolean }>('/api/events/toggle', { id: eventId, date, done })
        if (!res.ok) return res as unknown as IpcResult<never>
        return { ok: true as const, data: { event: { id: eventId } as never, date, done } }
      },
      skip: async (eventId: string, date: string) => {
        /*
         * 「仅删除本次」：往 event_skip 插一行，列表时这一天的实例就被滤掉。
         * 服务端 /api/events/skip 就是干这个的（行主键 = 事件id:日期）。
         * 以前这里是空壳（直接返回成功、什么都不做），所以手机上删重复待办
         * 只能走 remove → 整个重复全没了。
         */
        const res = await post<{ ok: boolean }>('/api/events/skip', { id: eventId, date })
        return res.ok ? { ok: true as const, data: true } : (res as unknown as IpcResult<never>)
      }
    },

    notes: {
      list: () => req<Note[]>('/api/notes'),
      get: (id: string) => req<Note>(`/api/notes/get?id=${encodeURIComponent(id)}`),
      create: async (input: NoteInput) => {
        const res = await post<{ id: string }>('/api/notes/save', {
          calendarId: input.calendarId,
          title: input.title ?? '',
          content: input.content
        })
        if (!res.ok) return res as unknown as IpcResult<never>
        return { ok: true as const, data: { id: res.data.id, ...input } as never }
      },
      update: async (id: string, patch: Partial<NoteInput>) => {
        const res = await post<{ id: string }>('/api/notes/save', {
          id,
          calendarId: patch.calendarId,
          title: patch.title,
          content: patch.content,
          pinned: patch.pinned
        })
        if (!res.ok) return res as unknown as IpcResult<never>
        return { ok: true as const, data: { id, ...patch } as never }
      },
      remove: async (id: string) => {
        const res = await post<{ ok: boolean }>('/api/notes/delete', { id })
        return res.ok ? { ok: true as const, data: true } : (res as unknown as IpcResult<never>)
      }
    },

    search: {
      query: (q: string) => req<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`)
    },

    // 回滚记录只存在于本机 SQLite：远端拿不到就退化成空列表 / 0，不抛错
    snapshots: {
      list: async () => {
        const res = await req<SnapshotMeta[]>('/api/snapshots')
        return res.ok ? res.data : []
      },
      restore: (id: string) => post<RestoreResult>('/api/snapshots/restore', { id }),
      clear: async () => {
        const res = await post<number>('/api/snapshots/clear', {})
        return res.ok ? res.data : 0
      }
    },

    sync: {
      getState: async (): Promise<SyncStateResult> => {
        const id = loadMobileIdentity()
        return {
          // 空串要走回退：老身份里可能存了个空地址，登录页就没东西可填
          serverUrl: id?.serverUrl || base(),
          deviceId: id?.deviceId ?? '',
          deviceName: id?.deviceName ?? '',
          accountId: id?.accountId ?? '',
          username: id?.username ?? '',
          paired: isMobilePaired(id)
        }
      },
      setServer: async (url: string, deviceName: string): Promise<SyncStateResult> => {
        const before = loadMobileIdentity()
        const next = ensureMobileIdentity({ serverUrl: url.trim(), deviceName })
        /*
         * 关键：ensureMobileIdentity 只写 localStorage，而 base() 读的是创建 host 时
         * 保存下来的这份 mobile 快照。不同步回去的话，刚填完服务器地址就登录，
         * 请求仍然打到旧地址（或空地址 → 相对路径 → https://localhost），
         * 浏览器只报 Failed to fetch —— 就是"退出登录后再也登不回来"的那个坑。
         */
        mobile.serverUrl = next.serverUrl
        mobile.deviceName = next.deviceName
        const changed = Boolean(before && before.serverUrl !== next.serverUrl)
        // 换服务器等于换账号：旧账号在另一台服务器上，先退出登录
        if (changed && next.accountId) {
          mobile.accountId = ''
          mobile.username = ''
          saveMobileIdentity(mobile)
          return {
            serverUrl: mobile.serverUrl,
            deviceId: mobile.deviceId,
            deviceName: mobile.deviceName,
            accountId: '',
            username: '',
            paired: false,
            loggedOut: true
          }
        }
        saveMobileIdentity(mobile)
        return {
          serverUrl: next.serverUrl,
          deviceId: next.deviceId,
          deviceName: next.deviceName,
          accountId: next.accountId,
          username: next.username ?? '',
          paired: isMobilePaired(next),
          loggedOut: false
        }
      },
      register: async (input: { username: string; password: string }) => {
        const res = await authCall<AuthResult>('/auth/register', {
          username: input.username,
          password: input.password,
          deviceId: mobile.deviceId,
          secret: mobile.deviceSecret,
          deviceName: mobile.deviceName
        })
        if (!res.ok) return res
        applyAuthResult(mobile, res.data)
        saveMobileIdentity(mobile)
        return res
      },
      login: async (input: { username: string; password: string }) => {
        const res = await authCall<AuthResult>('/auth/login', {
          username: input.username,
          password: input.password,
          deviceId: mobile.deviceId,
          secret: mobile.deviceSecret,
          deviceName: mobile.deviceName
        })
        if (!res.ok) return res
        applyAuthResult(mobile, res.data)
        saveMobileIdentity(mobile)
        return res
      },
      claim: async (input: { username: string; password: string }) => {
        const res = await authCall<{ accountId: string; username: string }>(
          '/auth/claim',
          { username: input.username, password: input.password },
          tokenOf()
        )
        if (!res.ok) return res
        mobile.accountId = res.data.accountId
        mobile.username = res.data.username
        saveMobileIdentity(mobile)
        return res
      },
      logout: async () => {
        await authCall<{ ok: boolean }>('/auth/logout', {}, tokenOf())
        mobile.accountId = ''
        mobile.username = ''
        saveMobileIdentity(mobile)
        return { ok: true as const, data: { loggedOut: true } }
      },
      me: async () => {
        try {
          const res = await fetch(base() + '/auth/me', {
            headers: {
              authorization: `Bearer ${mobile.deviceId}.${mobile.deviceSecret}`,
              'x-device-name': headerSafeName(mobile.deviceName)
            }
          })
          if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
          return { ok: true as const, data: (await res.json()) as { accountId: string; username: string; claimed: boolean; deviceId: string; deviceName: string } }
        } catch (err) {
          return { ok: false as const, error: (err as Error).message }
        }
      },
      devices: async (): Promise<IpcResult<DeviceListResult>> => {
        const res = await req<DeviceListResult>('/devices')
        // 设备名在服务端可能是百分号编码的（老版本 Worker 没解码就存了）。
        // 这里统一解一次再交给界面，避免直接看到一串 %E5%B0%8F…。
        if (res.ok) {
          return {
            ok: true as const,
            data: {
              ...res.data,
              devices: res.data.devices.map((d) => ({
                ...d,
                name: decodeDeviceNameHeader(d.name ?? '')
              }))
            }
          }
        }
        return res
      },
      revokeDevice: async (deviceId: string): Promise<IpcResult<boolean>> => {
        const res = await req<{ ok?: boolean }>('/devices/revoke', {
          method: 'POST',
          body: JSON.stringify({ deviceId, purge: true })
        })
        return res.ok ? { ok: true as const, data: true } : res
      },
      /** 变更探针：手机每隔几秒问一次服务端"有没有新东西" */
      changes: async () => {
        const res = await req<{ token?: number }>('/api/changes')
        // 把 ok 带出去：不然「连不上」和「没有变更」都是 remote 0，界面完全看不出区别
        return {
          local: 0,
          remote: Number(res.ok ? (res.data.token ?? 0) : 0),
          changed: false,
          ok: res.ok
        }
      },
      run: () =>
        Promise.resolve({ ok: true, pushed: 0, pulled: 0, failed: 0, errors: [], tables: {} }).then(
          (r) => ({ ...r, error: undefined })
        ) as Promise<{ ok: boolean; pushed: number; pulled: number; failed: number }>,
      onDone: () => () => {}
    },

    theme: {
      getMode: () => Promise.resolve((localStorage.getItem('caldesk.theme') as 'system') ?? 'system'),
      setMode: (mode: 'system' | 'light' | 'dark') => {
        localStorage.setItem('caldesk.theme', mode)
        return Promise.resolve(mode)
      }
    },

    app: { openMain: () => Promise.resolve() },
    onDataChanged: () => () => {},
    onSettingsChanged: () => () => {},
    mini: {
      toggle: () => Promise.resolve(false),
      setVisible: () => Promise.resolve(false),
      hide: () => Promise.resolve(),
      pin: () => Promise.resolve(false),
      setSize: (width: number, height: number) => Promise.resolve({ width, height }),
      resetSize: () =>
        Promise.resolve({ width: DEFAULT_MINI_WIDTH, height: DEFAULT_MINI_HEIGHT })
    },
    mcp: {
      getInfo: () => Promise.resolve({ port: null, url: null })
    }
  } as HostApi
}

/* ------------------------------ 桩 ------------------------------ */

function createStub(): HostApi {
  const fail = (name: string) => (): never => {
    throw new Error(`当前平台尚未接入「${name}」`)
  }
  const rejected = <T>(name: string): Promise<IpcResult<T>> =>
    Promise.resolve({ ok: false as const, error: `当前平台尚未接入「${name}」` })

  return {
    ping: () => Promise.resolve({ ok: false, ts: Date.now() }),
    window: {
      minimize: fail('最小化'),
      toggleMaximize: fail('最大化'),
      close: fail('关闭窗口'),
      isMaximized: () => Promise.resolve(false),
      onMaximizedChange: () => () => {}
    },
    settings: {
      get: () =>
        Promise.resolve({
          miniVisible: false,
          miniPinned: true,
          miniRange: 'month' as MiniRange,
          miniView: 'list' as MiniView,
          miniWidth: DEFAULT_MINI_WIDTH,
          miniHeight: DEFAULT_MINI_HEIGHT,
          autoStart: false,
          closeToTray: false
        }),
      setAutoStart: () => Promise.resolve(false),
      setCloseToTray: () => Promise.resolve(false),
      setMiniRange: (range: MiniRange) => Promise.resolve(range),
      setMiniView: (view: MiniView) => Promise.resolve(view)
    },
    calendars: {
      list: () => rejected<CalendarMeta[]>('视图列表'),
      create: () => rejected<{ created: CalendarMeta; calendars: CalendarMeta[] }>('新建视图'),
      update: () => rejected<CalendarMeta[]>('修改视图'),
      remove: () => rejected<CalendarMeta[]>('删除视图')
    },
    cells: {
      range: () => rejected<DayCell[]>('日格'),
      get: () => rejected<DayCell>('日格'),
      setText: () => rejected<DayCell>('日格'),
      appendLine: () => rejected<DayCell>('日格'),
      updateLine: () => rejected<DayCell>('日格'),
      deleteLine: () => rejected<DayCell>('日格'),
      setDone: () => rejected<DayCell>('日格')
    },
    events: {
      range: () => rejected<EventOccurrence[]>('事件'),
      create: () => rejected<EventInput>('事件'),
      update: () => rejected<EventInput>('事件'),
      remove: () => rejected<boolean>('事件'),
      setDone: () => rejected<EventOccurrence>('事件'),
      skip: () => rejected<boolean>('事件')
    },
    notes: {
      list: () => rejected<Note[]>('便签'),
      get: () => rejected<Note>('便签'),
      create: () => rejected<NoteInput>('便签'),
      update: () => rejected<Note>('便签'),
      remove: () => rejected<boolean>('便签')
    },
    search: { query: () => rejected<SearchHit[]>('搜索') },
    snapshots: {
      list: () => Promise.resolve([] as SnapshotMeta[]),
      restore: () => rejected<RestoreResult>('回滚'),
      clear: () => Promise.resolve(0)
    },
    sync: {
      getState: () =>
        Promise.resolve({
          serverUrl: '',
          deviceId: '',
          deviceName: 'unknown',
          accountId: '',
          username: '',
          paired: false
        }),
      setServer: () =>
        Promise.resolve({
          serverUrl: '',
          deviceId: '',
          deviceName: 'unknown',
          accountId: '',
          username: '',
          paired: false,
          loggedOut: false
        }),
      register: () => rejected<{ accountId: string; username: string }>('注册'),
      login: () => rejected<{ accountId: string; username: string }>('登录'),
      claim: () => rejected<{ accountId: string; username: string }>('认领账号'),
      logout: () => rejected<{ loggedOut: boolean }>('退出登录'),
      me: () =>
        rejected<{
          accountId: string
          username: string
          claimed: boolean
          deviceId: string
          deviceName: string
        }>('账号信息'),
      devices: () => rejected<DeviceListResult>('设备列表'),
      revokeDevice: () => rejected<boolean>('撤销设备'),
      changes: () => Promise.resolve({ local: 0, remote: 0, changed: false }),
      run: () => Promise.resolve({ ok: false, pushed: 0, pulled: 0, failed: 0, error: '未接入同步' }),
      onDone: () => () => {}
    },
    theme: {
      getMode: () => Promise.resolve('system' as const),
      setMode: () => Promise.resolve('system' as const)
    },
    app: { openMain: fail('打开主窗口') },
    onDataChanged: () => () => {},
    onSettingsChanged: () => () => {},
    mini: {
      toggle: () => Promise.resolve(false),
      setVisible: () => Promise.resolve(false),
      hide: () => Promise.resolve(),
      pin: () => Promise.resolve(false),
      setSize: (width: number, height: number) => Promise.resolve({ width, height }),
      resetSize: () =>
        Promise.resolve({ width: DEFAULT_MINI_WIDTH, height: DEFAULT_MINI_HEIGHT })
    },
    mcp: {
      getInfo: () => Promise.resolve({ port: null, url: null })
    }
  } as HostApi
}

/* ------------------------------ 解析宿主 ------------------------------ */

declare global {
  interface Window {
    __CALDESK_HTTP__?: HttpConfig
  }
}

function readStoredConfig(): HttpConfig | null {
  try {
    // 移动端：身份存在 caldesk.identity 里（配对通过后才有 accountId）
    const idRaw = localStorage.getItem('caldesk.identity')
    if (idRaw) {
      const id = JSON.parse(idRaw) as Partial<MobileIdentity>
      if (id.deviceId && id.deviceSecret) {
        return {
          url: id.serverUrl?.trim() || DEFAULT_SERVER_URL,
          deviceId: id.deviceId,
          deviceSecret: id.deviceSecret
        }
      }
    }
    // 旧版配置：只有一个全局令牌
    const raw = localStorage.getItem(HOST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<HttpConfig>
    if (!parsed.url || !parsed.token) return null
    return { url: parsed.url, token: parsed.token }
  } catch {
    return null
  }
}

let resolved: HostApi | null = null

export function host(): HostApi {
  if (resolved) return resolved
  const g = globalThis as unknown as { caldesk?: HostApi; __CALDESK_HTTP__?: HttpConfig }
  if (g.caldesk) {
    resolved = g.caldesk
    return resolved
  }
  if (g.__CALDESK_HTTP__?.url) {
    resolved = createHttpHost(g.__CALDESK_HTTP__)
    return resolved
  }
  const stored = readStoredConfig()
  // 移动端：即使还没配对，也用默认服务器起一个 HTTP host，
  // 这样「扫码配对」才能真的发请求（stub 只会报"未接入同步"）
  resolved = stored ? createHttpHost(stored) : createHttpHost({ url: DEFAULT_SERVER_URL })
  return resolved
}

export const data: HostApi = new Proxy({} as HostApi, {
  get(_target, prop) {
    const h = host() as unknown as Record<PropertyKey, unknown>
    const value = h[prop as string]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(h) : value
  },
  has(_target, prop) {
    return prop in (host() as object)
  }
}) as HostApi
