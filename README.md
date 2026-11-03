# caldesk

一个本地优先的桌面日历（Electron + React），自带可选的 Cloudflare 同步后端。
日程存在本机 SQLite，手机与电脑之间通过 Cloudflare Worker + D1 做 LWW 同步，不需要自己的服务器。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/main/` | Electron 主进程：窗口、托盘、SQLite（`db.ts`）、本地 MCP/CLI HTTP 服务（`api.ts`）、同步（`sync.ts`）、回滚快照 |
| `src/preload/` | 渲染层可见的 `window.caldesk` 桥（IPC） |
| `src/renderer/` | React 界面：月历网格、详情面板、便签/搜索/设置侧栏、右下角任务浮窗（`mini.tsx`） |
| `src/shared/` | 主进程与渲染层共用的类型、RRULE 展开器、MCP 工具定义 |
| `worker/` | Cloudflare Worker + D1 同步服务（`wrangler.toml` 在这里） |
| `bin/` | `cal` 命令行、`cal-mcp` stdio 桥（给 Codex / Claude 之类接 MCP） |
| `mp/` | 微信小程序工程（备用） |
| `scripts/` | 校验与端到端脚本（`verify-*.mjs`、`e2e-*.js`） |

## 本地开发

```bash
npm install
npm run dev          # 开发模式（electron-vite）
npm run typecheck    # 主进程 + 渲染层类型检查
npm run build        # 构建 out/
npm run dist         # 打 Windows 安装包（NSIS）
```

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
- 密钥：`SYNC_TOKEN`（Worker → 设置 → 变量和密钥，加密变量）

表结构不用手工建：Worker 首次请求会执行 `worker/src/schema.ts` 里的
`CREATE TABLE IF NOT EXISTS`（每个 isolate 一次）。

### 接口

所有接口都要 `Authorization: Bearer <SYNC_TOKEN>`；预检 `OPTIONS` 直接放行以便浏览器/手机 WebView 跨域。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探测，返回 D1 是否绑定 |
| GET | `/sync/pull?table=&since=&limit=` | 增量拉取（按 `updated_at` 游标） |
| POST | `/sync/push` | 批量写入，服务端同样做 LWW 守卫 |
| GET/POST | `/api/calendars`、`/api/cells*`、`/api/events*`、`/api/notes*`、`/api/search` | 手机端用的 REST 接口 |

数据模型刻意做得很薄：所有集合都存在 `rows(tbl, id, updated_at, deleted_at, payload)` 一张表里，
加集合不用改表；冲突用 `updated_at` 大的胜出，删除用 `deleted_at` 墓碑。

### 客户端怎么连

桌面端在「设置 → 同步（Cloudflare）」里填 Worker 地址与令牌，会写到
`%APPDATA%/caldesk/sync.json`。填好后每 5 分钟自动同步一次，也可手动「立即同步」。

## 相关文档

- `docs/部署与安装.md`：从零部署与安装步骤
