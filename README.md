# caldesk

一个本地优先的桌面日历（Electron + React），自带可选的 Cloudflare 同步后端。
日程存在本机 SQLite，手机与电脑之间通过 Cloudflare Worker + D1 做 LWW 同步，不需要自己的服务器。

桌面端和手机端是**两套独立界面**：桌面端用 `App.tsx`（多栏、桌面浮窗），
手机端用 `MobileApp.tsx`（月历网格、底部导航、拇指可达），构建也完全分开。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/main/` | Electron 主进程：窗口、托盘、SQLite（`db.ts`）、本地 MCP/CLI HTTP 服务（`api.ts`）、同步（`sync.ts`）、回滚快照 |
| `src/preload/` | 渲染层可见的 `window.caldesk` 桥（IPC） |
| `src/renderer/src/App.tsx` | **桌面端**界面：月历网格、详情面板、便签/搜索/设置侧栏、右下角任务浮窗（`mini.tsx`） |
| `src/renderer/src/MobileApp.tsx` | **手机端**界面：月历网格 + 当天详情 + 底部导航 + 悬浮加号 |
| `src/renderer/src/mobile.css` | 手机端设计系统（安全区、主题跟随） |
| `src/shared/` | 主进程与渲染层共用的类型、RRULE 展开器、MCP 工具定义 |
| `worker/` | Cloudflare Worker + D1 同步服务（`wrangler.toml` 在这里） |
| `bin/` | `cal` 命令行、`cal-mcp` stdio 桥（给 Codex / Claude 之类接 MCP） |
| `scripts/` | 校验与端到端脚本（`verify-*.mjs`、`e2e-*.js`） |

## 本地开发

```bash
npm install
npm run dev          # 开发模式（electron-vite）
npm run typecheck    # 主进程 + 渲染层类型检查
npm run build        # 构建桌面端 out/
npm run build:mobile # 构建手机端 out/mobile/
npm run dist         # 打 Windows 安装包（NSIS）
```

安卓端：

```bash
npm run build:mobile
npx cap sync android
cd android && gradlew assembleDebug
```

> `android/` 由 `npx cap add android` 生成、不进版本库。重新生成后要补两件事：
> 跑一次 `python scripts/make-icons.py`（应用图标与启动图），
> 并在 `AndroidManifest.xml` 里补 `android.permission.VIBRATE`（底栏跨格的轻震动）。
> 另外 `android/local.properties` 要写本机的 `sdk.dir`，否则 gradle 找不到 SDK。

命令行：

```bash
node bin/cal.mjs list                       # 列出视图
node bin/cal.mjs add 2026-11-03 "写周报"     # 追加当天任务
node bin/cal.mjs day 2026-11-03             # 看某天
node bin/cal.mjs events --from 2026-11-01 --to 2026-11-30
```

MCP（给 AI 用）：`node bin/cal-mcp.mjs`，工具定义在 `src/shared/tools.ts`。

## 同步后端（Worker + D1）

`worker/` 通过 **Workers Builds** 直接连这个 GitHub 仓库部署：推送 `main` 就自动构建上线。

- 根目录：`worker/`
- 构建命令：`npm ci`
- 部署命令：`npx wrangler deploy`
- D1 绑定：`DB` → 数据库 `caldesk`（id 写在 `worker/wrangler.toml`）

表结构不用手工建：Worker 首次请求会执行 `worker/src/schema.ts` 里的
`CREATE TABLE IF NOT EXISTS`（每个 isolate 一次）。

### 账号与配对模型

**没有全局共享令牌**。每台设备一套凭据：

- 凭据形态：`Authorization: Bearer <deviceId>.<deviceSecret>`
- 服务端只存 `sha256(salt || deviceSecret)`，明文 secret 不落库
- 新设备走**配对**：电脑生成 6 位码（5 分钟有效）→ 手机扫码或输码申请
  → 电脑在「同步 → 待批准设备」里批准 → 服务端把手机挂进同一个 `account_id`
- 账号由凭据反查（`devices.account_id`），**永远不从请求体取**
- 所有读写按 `account_id` 过滤，跨账号看不到对方数据
- 设备可以在电脑端随时撤销，撤销后该设备立刻 401

服务端存明文（用户明确要求简单方便），隐私靠上面这套隔离保证。

### 接口

预检 `OPTIONS` 直接放行以便手机 WebView 跨域。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探测，返回 D1 是否绑定 |
| POST | `/pair/start` | 电脑发起配对，生成 6 位码 |
| POST | `/pair/join` | 手机申请入伙（`pairId` 可空，服务端按码查） |
| GET | `/pair/status` | 查配对状态；批准后返回 `accountId` |
| POST | `/pair/approve` / `/pair/reject` | 电脑批准 / 拒绝 |
| GET | `/devices` | 列出本账号设备 |
| POST | `/devices/revoke` | 撤销设备 |
| GET | `/api/changes` | 账号内最新 `updated_at`，各端拿它做热更新轮询 |
| GET/POST | `/api/calendars`、`/api/cells*`、`/api/events*`、`/api/notes*`、`/api/search` | 手机端用的 REST 接口 |

### 热更新（不用退出重进）

任何一端改完数据，其他端几秒内自动更新，靠的是 `/api/changes`：

1. 每次写入都会刷新 `rows.updated_at`，所以账号的 `MAX(updated_at)` 就是"变更水位"。
2. 客户端每 5 秒问一次这个水位，和上次看到的比：一样就什么都不做，变大了才去拉数据。
3. 桌面端探到变化后调一次 `syncNow()`（推 + 拉），拉下来的行通过 IPC 广播 `data:changed`，界面立刻重读当月。
4. 手机端是直接读 REST，探到变化就重跑一次 `loadRange()`；另外监听 `visibilitychange`，从后台切回来也刷一次。

比"每次全量轮询"省得多，又不用维持长连接（免费额度友好）。

数据模型刻意做得很薄：所有集合都存在 `rows(tbl, account_id, id, updated_at, deleted_at, payload)` 一张表里，
加集合不用改表；冲突用 `updated_at` 大的胜出，删除用 `deleted_at` 墓碑。

### 客户端怎么连

桌面端在「设置 → 同步」里填你自己部署的 Worker 地址（`docs/部署与安装.md` 有从零部署的步骤）。
填好后本地一有改动 3 秒后自动推送，另外每 5 分钟对一次账。
仓库与发布包里都不预置任何人的服务器地址，地址只存在你本机的身份文件里。

## 相关文档

- `docs/部署与安装.md`：从零部署与安装步骤
