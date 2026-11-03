/**
 * 数据访问边界。
 *
 * 渲染层只认识 `data`，不直接碰宿主 API。宿主按优先级解析：
 *   1. window.caldesk —— Electron preload 注入的 IPC
 *   2. window.__CALDESK_HTTP__ —— Capacitor / 测试夹具注入的远端配置
 *   3. localStorage 里的同步配置 —— 浏览器直接打开时用
 *   4. 桩 —— 显式报错，而不是白屏
 */
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

type HostApi = Window['caldesk']
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface HttpConfig {
  url: string
  token: string
}

const HOST_KEY = 'caldesk.http'

/* ------------------------------ HTTP 适配器 ------------------------------ */

export function createHttpHost(cfg: HttpConfig): HostApi {
  const base = cfg.url.replace(/\/$/, '')

  async function req<T>(path: string, init?: RequestInit): Promise<IpcResult<T>> {
    try {
      const res = await fetch(base + path, {
        ...init,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          'content-type': 'application/json',
          ...(init?.headers ?? {})
        }
      })
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

    settings: { get: () => Promise.resolve({ miniVisible: false, miniPinned: false }) },

    calendars: {
      list: () => req<CalendarMeta[]>('/api/calendars'),
      create: async (name: string) => {
        const created = await post<CalendarMeta>('/api/calendars/create', { name })
        if (!created.ok) return created as unknown as IpcResult<never>
        const list = await req<CalendarMeta[]>('/api/calendars')
        return list.ok
          ? { ok: true as const, data: { created: created.data, calendars: list.data } }
          : (list as unknown as IpcResult<never>)
      },
      update: () => Promise.resolve({ ok: false as const, error: '移动端暂不支持重命名视图' }),
      remove: async (id: string) => {
        const res = await post<{ ok: boolean }>('/api/calendars/delete', { id })
        if (!res.ok) return res as unknown as IpcResult<never>
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
        // 没有整格替换端点：先删空再逐行追加成本高，这里用"覆盖"语义的追加替代
        const cur = await req<Array<{ date: string; text: string }>>(
          `/api/cells?calendar=${encodeURIComponent(calendarId)}&from=${date}&to=${date}`
        )
        const old = cur.ok ? (cur.data.find((r) => r.date === date)?.text ?? '') : ''
        const oldLines = old ? old.split('\n').length : 0
        for (let i = 0; i < oldLines; i += 1) {
          await post('/api/cells/remove-line', { calendar: calendarId, date, index: 0 })
        }
        let last = ''
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          const res = await post<{ text: string }>('/api/cells/append', { calendar: calendarId, date, text: line })
          if (!res.ok) return res as unknown as IpcResult<never>
          last = res.data.text
        }
        return { ok: true as const, data: toCell(calendarId, { date, text: last }) }
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
      skip: async () => ({ ok: true as const, data: true })
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
      getConfig: () => Promise.resolve({ url: cfg.url, hasToken: Boolean(cfg.token) }),
      setConfig: (url: string, token: string) => {
        localStorage.setItem(HOST_KEY, JSON.stringify({ url, token }))
        return Promise.resolve({ url, hasToken: Boolean(token) })
      },
      run: () =>
        Promise.resolve({ ok: true, pushed: 0, pulled: 0, failed: 0 }).then((r) => ({
          ...r,
          error: undefined
        })) as Promise<{ ok: boolean; pushed: number; pulled: number; failed: number }>,
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
    mini: {
      toggle: () => Promise.resolve(false),
      setVisible: () => Promise.resolve(false),
      hide: () => Promise.resolve(),
      pin: () => Promise.resolve(false)
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
    settings: { get: () => Promise.resolve({ miniVisible: false, miniPinned: true }) },
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
      getConfig: () => Promise.resolve({ url: '', hasToken: false }),
      setConfig: () => Promise.resolve({ url: '', hasToken: false }),
      run: () => Promise.resolve({ ok: false, pushed: 0, pulled: 0, failed: 0, error: '未接入同步' }),
      onDone: () => () => {}
    },
    theme: {
      getMode: () => Promise.resolve('system' as const),
      setMode: () => Promise.resolve('system' as const)
    },
    app: { openMain: fail('打开主窗口') },
    onDataChanged: () => () => {},
    mini: {
      toggle: () => Promise.resolve(false),
      setVisible: () => Promise.resolve(false),
      hide: () => Promise.resolve(),
      pin: () => Promise.resolve(false)
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
  resolved = stored ? createHttpHost(stored) : createStub()
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
