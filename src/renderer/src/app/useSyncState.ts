/**
 * 同步身份：服务器地址、账号密码、设备列表、在线状态、热更新轮询。
 *
 * 这些 state 的共同点是「都跟着一次网络请求回来」，和月历数据没有关系；
 * 以前它们和 42 个格子的 state 挤在同一个组件里，一条轮询回包就会重跑整棵树。
 */
import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { data } from '../data'
import { DEFAULT_SERVER_URL } from '@shared/identity'
import { generateStrongPassword } from '../password'
import { read } from './util'

export interface DeviceRow {
  deviceId: string
  name: string
  status: string
  lastSeenAt: number | null
  lastIp: string | null
  current: boolean
}

export interface SyncState {
  syncUrl: string
  setSyncUrl: Dispatch<SetStateAction<string>>
  syncDeviceName: string
  syncAccountId: string
  syncUsername: string
  syncPaired: boolean
  /** 没登录时显示登录还是注册 */
  authMode: 'login' | 'register'
  setAuthMode: Dispatch<SetStateAction<'login' | 'register'>>
  authUser: string
  setAuthUser: Dispatch<SetStateAction<string>>
  authPassword: string
  setAuthPassword: Dispatch<SetStateAction<string>>
  authBusy: boolean
  deviceList: DeviceRow[]
  syncOnline: number
  syncMsg: string | null
  setSyncMsg: Dispatch<SetStateAction<string | null>>
  syncing: boolean
  /** 轮询探不到服务器时置真，只在顶栏亮一枚小标，不打断任何操作 */
  offline: boolean
  /** 重新对齐主进程里的身份真值（打开设置面板时用） */
  reloadState: () => void
  saveSyncServer: () => Promise<void>
  /** 把地址恢复成构建期内置的默认服务器，走和「保存」同一条提交路径 */
  restoreDefaultServer: () => Promise<void>
  fillStrongPassword: () => void
  submitAuth: () => Promise<void>
  claimExisting: () => Promise<void>
  logoutSync: () => Promise<void>
  refreshDevices: () => Promise<void>
  revokeDevice: (deviceId: string) => Promise<void>
  runSyncNow: () => Promise<void>
  applyServer: (url: string, deviceName: string, okMsg: string) => Promise<void>
}

export function useSyncState(opts: { reloadAll: () => Promise<void> }): SyncState {
  const { reloadAll } = opts

  const [syncUrl, setSyncUrl] = useState('')
  const [syncDeviceName, setSyncDeviceName] = useState('')
  const [syncAccountId, setSyncAccountId] = useState('')
  const [syncUsername, setSyncUsername] = useState('')
  const [syncPaired, setSyncPaired] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authUser, setAuthUser] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [deviceList, setDeviceList] = useState<DeviceRow[]>([])
  const [syncOnline, setSyncOnline] = useState(0)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [offline, setOffline] = useState(false)

  const reloadState = useCallback(() => {
    read(data.sync.getState(), (s) => {
      setSyncUrl(s.serverUrl)
      setSyncDeviceName(s.deviceName)
      setSyncAccountId(s.accountId)
      setSyncUsername(s.username)
      setSyncPaired(s.paired)
    })
  }, [])

  useEffect(() => {
    reloadState()
  }, [reloadState])

  /** 设备列表 + 在线数 */
  async function refreshDevices(): Promise<void> {
    try {
      const res = await data.sync.devices()
      if (res.ok) {
        setDeviceList(res.data.devices)
        setSyncOnline(res.data.online)
      }
    } catch (err) {
      setSyncMsg(`读取设备列表失败：${(err as Error).message}`)
    }
  }

  useEffect(() => {
    if (syncPaired) void refreshDevices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncPaired])

  /** 保存服务器地址与本机设备名（「恢复默认服务器」也走这条路） */
  async function applyServer(url: string, deviceName: string, okMsg: string): Promise<void> {
    const res = await data.sync.setServer(url.trim(), deviceName.trim())
    setSyncUrl(res.serverUrl)
    setSyncDeviceName(res.deviceName)
    setSyncPaired(res.paired)
    if (res.loggedOut) {
      setSyncAccountId('')
      setSyncUsername('')
      setDeviceList([])
      setSyncMsg('换了服务器，请重新登录')
    } else {
      setSyncMsg(okMsg)
    }
  }

  async function saveSyncServer(): Promise<void> {
    await applyServer(syncUrl, syncDeviceName, '已保存')
  }

  async function restoreDefaultServer(): Promise<void> {
    await applyServer(DEFAULT_SERVER_URL, syncDeviceName, '已恢复默认服务器')
  }

  function fillStrongPassword(): void {
    const pw = generateStrongPassword()
    setAuthPassword(pw)
    void navigator.clipboard?.writeText(pw).catch(() => {})
    setSyncMsg('已生成强密码并复制到剪贴板')
  }

  /** 登录 / 注册：任意设备登录同一账号，就绑到同一份数据上 */
  async function submitAuth(): Promise<void> {
    const username = authUser.trim()
    if (!username || !authPassword) {
      setSyncMsg('请填写用户名和密码')
      return
    }
    setAuthBusy(true)
    setSyncMsg(authMode === 'login' ? '正在登录…' : '正在注册…')
    const res =
      authMode === 'login'
        ? await data.sync.login({ username, password: authPassword })
        : await data.sync.register({ username, password: authPassword })
    setAuthBusy(false)
    if (!res.ok) {
      setSyncMsg(`${authMode === 'login' ? '登录' : '注册'}失败：${res.error}`)
      return
    }
    setSyncAccountId(res.data.accountId)
    setSyncUsername(res.data.username)
    setSyncPaired(true)
    setAuthPassword('')
    setSyncMsg(authMode === 'login' ? '已登录，正在同步…' : '账号已创建，手机用同一个账号登录即可')
    void refreshDevices()
    await runSyncNow()
  }

  /** 配对时代的老账号：用现有凭据设一次用户名密码，数据一行不动 */
  async function claimExisting(): Promise<void> {
    const username = authUser.trim()
    if (!username || !authPassword) {
      setSyncMsg('请填写用户名和密码')
      return
    }
    setAuthBusy(true)
    const res = await data.sync.claim({ username, password: authPassword })
    setAuthBusy(false)
    if (!res.ok) {
      setSyncMsg(`设置失败：${res.error}`)
      return
    }
    setSyncUsername(res.data.username)
    setAuthPassword('')
    setSyncMsg('已设置用户名密码，其他设备可以直接登录了')
  }

  async function logoutSync(): Promise<void> {
    await data.sync.logout()
    setSyncPaired(false)
    setSyncAccountId('')
    setSyncUsername('')
    setDeviceList([])
    setSyncMsg('已退出登录，本机数据还在')
  }

  async function revokeDevice(deviceId: string): Promise<void> {
    const res = await data.sync.revokeDevice(deviceId)
    setSyncMsg(res.ok ? '已删除该设备' : `删除失败：${res.error}`)
    void refreshDevices()
  }

  async function runSyncNow(): Promise<void> {
    setSyncing(true)
    setSyncMsg('同步中…')
    const r = await data.sync.run()
    setSyncing(false)
    setSyncMsg(
      r.ok
        ? `完成：上传 ${r.pushed}，下载 ${r.pulled}${r.failed > 0 ? `，失败 ${r.failed}` : ''}`
        : (r.error ?? '同步失败')
    )
  }

  // 同步跑完（含"立即同步"和后台每 5 分钟那次）：有下载就重读
  useEffect(() => {
    return data.sync.onDone((r) => {
      setSyncMsg(r.ok ? `同步完成：上传 ${r.pushed}，下载 ${r.pulled}` : '同步失败')
      if (r.ok && r.pulled > 0) void reloadAll()
    })
  }, [reloadAll])

  /**
   * 热更新：定期问服务端"有没有新东西"。
   *
   * 之前只有本机改动才会刷新，别的设备（手机、AI、CLI）改完，
   * 这边必须退出重进才看得到。现在探到水位变了就立刻拉一次。
   */
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const probe = await data.sync.changes()
        if (stopped) return
        // 连不上要能看见：以前失败和"没变更"都返回 changed:false，界面完全没提示
        setOffline(probe.ok === false)
        if (probe.changed) {
          // 有新东西：先同步进本地库，再整块重读（日历列表也可能变了）
          await data.sync.run()
          if (!stopped) await reloadAll()
        }
      } catch {
        if (!stopped) setOffline(true)
      }
      if (!stopped) timer = setTimeout(() => void tick(), 5000)
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [reloadAll])

  return {
    syncUrl,
    setSyncUrl,
    syncDeviceName,
    syncAccountId,
    syncUsername,
    syncPaired,
    authMode,
    setAuthMode,
    authUser,
    setAuthUser,
    authPassword,
    setAuthPassword,
    authBusy,
    deviceList,
    syncOnline,
    syncMsg,
    setSyncMsg,
    syncing,
    offline,
    reloadState,
    saveSyncServer,
    restoreDefaultServer,
    fillStrongPassword,
    submitAuth,
    claimExisting,
    logoutSync,
    refreshDevices,
    revokeDevice,
    runSyncNow,
    applyServer
  }
}
