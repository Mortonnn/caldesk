import { contextBridge, ipcRenderer } from 'electron'
import type {
  CalendarEvent,
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

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

const api = {
  ping: () => ipcRenderer.invoke('app:ping') as Promise<{ ok: boolean; ts: number }>,
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_e: unknown, v: boolean): void => cb(v)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<{
      miniVisible: boolean
      miniPinned: boolean
    }>
  },
  calendars: {
    list: () => ipcRenderer.invoke('calendars:list') as Promise<IpcResult<CalendarMeta[]>>,
    create: (name: string, color?: string) =>
      ipcRenderer.invoke('calendars:create', name, color) as Promise<
        IpcResult<{ created: CalendarMeta; calendars: CalendarMeta[] }>
      >,
    update: (id: string, patch: { name?: string; color?: string }) =>
      ipcRenderer.invoke('calendars:update', id, patch) as Promise<IpcResult<CalendarMeta[]>>,
    remove: (id: string) =>
      ipcRenderer.invoke('calendars:delete', id) as Promise<IpcResult<CalendarMeta[]>>
  },
  cells: {
    range: (calendarId: string, from: string, to: string) =>
      ipcRenderer.invoke('cells:range', calendarId, from, to) as Promise<IpcResult<DayCell[]>>,
    get: (calendarId: string, date: string) =>
      ipcRenderer.invoke('cells:get', calendarId, date) as Promise<IpcResult<DayCell>>,
    setText: (calendarId: string, date: string, text: string) =>
      ipcRenderer.invoke('cells:setText', calendarId, date, text) as Promise<IpcResult<DayCell>>,
    appendLine: (calendarId: string, date: string, text: string) =>
      ipcRenderer.invoke('cells:appendLine', calendarId, date, text) as Promise<IpcResult<DayCell>>,
    updateLine: (calendarId: string, date: string, index: number, text: string) =>
      ipcRenderer.invoke('cells:updateLine', calendarId, date, index, text) as Promise<
        IpcResult<DayCell>
      >,
    deleteLine: (calendarId: string, date: string, index: number) =>
      ipcRenderer.invoke('cells:deleteLine', calendarId, date, index) as Promise<IpcResult<DayCell>>,
    setDone: (calendarId: string, date: string, index: number, done: boolean) =>
      ipcRenderer.invoke('cells:setDone', calendarId, date, index, done) as Promise<
        IpcResult<DayCell>
      >
  },
  events: {
    range: (calendarId: string, from: string, to: string, kind?: string) =>
      ipcRenderer.invoke('events:range', calendarId, from, to, kind) as Promise<
        IpcResult<EventOccurrence[]>
      >,
    create: (input: EventInput) =>
      ipcRenderer.invoke('events:create', input) as Promise<IpcResult<CalendarEvent>>,
    update: (id: string, patch: Partial<EventInput>) =>
      ipcRenderer.invoke('events:update', id, patch) as Promise<IpcResult<CalendarEvent>>,
    remove: (id: string) => ipcRenderer.invoke('events:delete', id) as Promise<IpcResult<boolean>>,
    setDone: (eventId: string, date: string, done: boolean) =>
      ipcRenderer.invoke('events:setDone', eventId, date, done) as Promise<
        IpcResult<EventOccurrence>
      >,
    skip: (eventId: string, date: string) =>
      ipcRenderer.invoke('events:skip', eventId, date) as Promise<IpcResult<boolean>>
  },
  notes: {
    list: (calendarId?: string) =>
      ipcRenderer.invoke('notes:list', calendarId) as Promise<IpcResult<Note[]>>,
    get: (id: string) => ipcRenderer.invoke('notes:get', id) as Promise<IpcResult<Note>>,
    create: (input: NoteInput) =>
      ipcRenderer.invoke('notes:create', input) as Promise<IpcResult<Note>>,
    update: (id: string, patch: Partial<NoteInput>) =>
      ipcRenderer.invoke('notes:update', id, patch) as Promise<IpcResult<Note>>,
    remove: (id: string) => ipcRenderer.invoke('notes:delete', id) as Promise<IpcResult<boolean>>
  },
  search: {
    query: (query: string, calendarId?: string, limit?: number) =>
      ipcRenderer.invoke('search:query', query, calendarId, limit) as Promise<
        IpcResult<SearchHit[]>
      >
  },
  /** 本地回滚记录：只存在于本机 SQLite，HTTP 宿主拿不到时由渲染层降级 */
  snapshots: {
    list: () => ipcRenderer.invoke('snapshots:list') as Promise<SnapshotMeta[]>,
    restore: (id: string) =>
      ipcRenderer.invoke('snapshots:restore', id) as Promise<IpcResult<RestoreResult>>,
    clear: () => ipcRenderer.invoke('snapshots:clear') as Promise<number>
  },
  sync: {
    getConfig: () =>
      ipcRenderer.invoke('sync:get-config') as Promise<{ url: string; hasToken: boolean }>,
    setConfig: (url: string, token: string) =>
      ipcRenderer.invoke('sync:set-config', url, token) as Promise<{
        url: string
        hasToken: boolean
      }>,
    run: () =>
      ipcRenderer.invoke('sync:run') as Promise<{
        ok: boolean
        pushed: number
        pulled: number
        failed: number
        error?: string
      }>,
    onDone: (cb: (report: { ok: boolean; pushed: number; pulled: number }) => void): (() => void) => {
      const handler = (_e: unknown, report: { ok: boolean; pushed: number; pulled: number }): void =>
        cb(report)
      ipcRenderer.on('sync:done', handler)
      return () => ipcRenderer.removeListener('sync:done', handler)
    }
  },
  app: {
    openMain: () => ipcRenderer.invoke('app:open-main')
  },
  /** 主进程广播"数据变了"：浮窗和主窗口共用一份库，必须互相通知重读 */
  onDataChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('data:changed', handler)
    return () => ipcRenderer.removeListener('data:changed', handler)
  },
  mini: {
    toggle: () => ipcRenderer.invoke('mini:toggle') as Promise<boolean>,
    setVisible: (visible: boolean) =>
      ipcRenderer.invoke('mini:set-visible', visible) as Promise<boolean>,
    hide: () => ipcRenderer.invoke('mini:hide'),
    pin: (pinned: boolean) => ipcRenderer.invoke('mini:pin', pinned) as Promise<boolean>
  },
  theme: {
    getMode: () => ipcRenderer.invoke('theme:get-mode') as Promise<'system' | 'light' | 'dark'>,
    setMode: (mode: 'system' | 'light' | 'dark') =>
      ipcRenderer.invoke('theme:set-mode', mode) as Promise<'system' | 'light' | 'dark'>
  }
}

// CALDESK_HTTP_ONLY=1 时故意不注入 IPC，用于验证「纯 HTTP 宿主」路径（等同 Android/浏览器环境）
const httpOnly = process.env.CALDESK_HTTP_ONLY === '1'
if (!httpOnly) {
  contextBridge.exposeInMainWorld('caldesk', api)
}

const httpCfgRaw = process.env.CALDESK_HTTP
if (httpCfgRaw) {
  try {
    contextBridge.exposeInMainWorld('__CALDESK_HTTP__', JSON.parse(httpCfgRaw))
  } catch {
    /* 配置不合法就忽略，页面会落到桩 */
  }
}

export type CaldeskApi = typeof api
