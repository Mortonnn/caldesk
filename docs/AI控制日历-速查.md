# caldesk × AI 控制速查

> 给「想让 AI 直接增添查改日历」的人和 Agent 看。caldesk 用自己的一套本地服务，
> 和旧软件「日历清单」的协议无关；看这一篇就够。

## 一句话

caldesk 桌面端一启动，就在 **127.0.0.1:19283** 开了一个 MCP 服务（JSON-RPC 2.0 over HTTP POST）；
AI 通过它读写日历，改动立刻反映到界面并参与同步。不需要额外开关、不需要插件、不需要联网。

```
AI 软件 / 脚本
   │  MCP (JSON-RPC 2.0，POST /mcp)
   ▼
caldesk 桌面端内置 MCP 服务  ← 127.0.0.1:19283/mcp（只绑回环）
   │
   ▼
本机 SQLite + 同步引擎（写操作会广播给所有窗口重读）
```

## 生效前提（三条，缺一不可）

1. **caldesk 桌面端正在运行**（不是手机端、不是浏览器网页版）。
2. 端口默认 **19283**（可用环境变量 `CALDESK_MCP_PORT` 覆盖），实际端口写进
   `%APPDATA%\caldesk\runtime.json`（Win）/ `~/.config/caldesk/runtime.json`（mac、Linux），
   内容形如 `{ "port": 19283, "pid": 12345, "startedAt": ..., "instanceId": "...", "token": "..." }`
   （`token` 只在启用了共享令牌时出现，见下文「安全模型」）。
3. 想让 AI 直接连，用 `cal-mcp` 桥；只想跑命令，用 `cal` CLI。两者都自动读 runtime.json，不用手抄端口。

验证服务活着：

```bash
node caldesk/bin/cal.mjs list
# 输出视图列表（含每个 id/name/color）就说明通了
```

## 两条接入方式

### A. 把 caldesk 挂成 AI 的 MCP 服务（推荐给 Codex / Claude Desktop / Cursor）

`cal-mcp.mjs` 是 stdio↔HTTP 的桥：stdin 读 JSON-RPC（一行一条），转发给本地服务，应答写回 stdout。
**stdout 只有协议报文**，日志一律走 stderr。

**Codex** — `~/.codex/config.toml`：

```toml
[mcp_servers.caldesk]
command = "node"
args = ["D:/你的路径/caldesk/bin/cal-mcp.mjs"]
```

**Claude Desktop** — `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "caldesk": {
      "command": "node",
      "args": ["D:/你的路径/caldesk/bin/cal-mcp.mjs"]
    }
  }
}
```

路径换成你本机的实际路径。若桌面端不在默认目录，设环境变量 `CALDESK_RUNTIME` 指向 `runtime.json`，
或设 `CALDESK_URL=http://127.0.0.1:19283` 直接指定；令牌用 `CALDESK_TOKEN` 覆盖。

### B. 命令行（推荐给脚本 / Agent 自己调）

```bash
cal() { node caldesk/bin/cal.mjs "$@"; }   # 或 npm 里的 cal / cal-mcp 两个 bin
```

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行/接口错误（服务没开、日期非法、id 不存在…） |
| 2 | 用法错误（缺参数、行号不是数字、未知子命令、`--kind` 非法…） |

`--json` 输出原始 JSON；**失败时也输出 JSON**（`{"ok":false,"error":{"message":…,"code":…}}`），
方便 Agent 直接解析，不用去啃中文提示。`--url` 覆盖端口自动发现，`--token` 覆盖令牌。

## 增添查改：命令 ↔ MCP 工具对照

| 动作 | CLI | MCP 工具 |
|---|---|---|
| **查**上下文（今天日期、默认视图） | — | `context` |
| **查**视图列表 | `cal list` | `calendar_list` |
| **查**某天任务 | `cal day 2026-11-05` | `items_get {date, calendar_id?}` |
| **查**区间任务 | — | `items_query {from, to, calendar_id?}` |
| **查**事件 | `cal events --from 2026-11-01 --to 2026-11-30 --kind all` | `events_query {from,to,kind}` |
| **查**全文 | `cal search 关键词` | `search {query}` |
| **增**任务行 | `cal add 2026-11-05 买牛奶` | `items_append_line {date,text}` |
| **增**事件 | `cal new-event 站会 --kind task --start 2026-11-06 --rrule "FREQ=WEEKLY;BYDAY=MO"` | `event_create {title,kind,start,rrule?,target_date?}` |
| **改**整段文本 | — | `items_set {date,text}`（空串 = 清空整格） |
| **改**某一行文字 | — | `item_line_update {date,index,text}` |
| **改**完成 / 取消 | `cal done 2026-11-05 0` / `cal undone 2026-11-05 0` | `item_line_set_done {date,index,done}` |
| **改**事件（标题/类型/重复/日期） | — | `event_update {id,…}`（`rrule`/`target_date` 传 `null` 清空） |
| **挪**任务到另一天 | — | `item_line_move {from_date,index,to_date}`（同天会报错） |
| **删**任务行 | `cal rm 2026-11-05 0` | `item_line_delete {date,index}` |
| **删**事件 | `cal del-event <id>` | `event_delete {id}` |
| **便签**增删查改 | — | `notes_list / notes_get / notes_create / notes_update / notes_delete` |

说明：

- 不带 `calendar_id` 时，默认用**第一个视图**；多视图操作要显式传 `cal list` 里的 id。
- 行号 `index` 从 `0` 开始，是当天任务列表里的顺序，不是数据库 id。
  **必须是 JSON 整数**（`0`，不是 `"0"`）；服务端会拒绝字符串 / `null`，避免静默操作第 0 行。
- **写操作会广播**给主窗口和浮窗重读，AI 改完不用手动刷新；只读工具不触发刷新。
- 本机改动会进入同步引擎（每 5 秒探一次水位、后台每 5 分钟全量拉），手机端也能看到。

## 参数槽点（AI 最常踩的几条）

| 场景 | 行为 |
|---|---|
| `items_append_line` 的 `text` 带换行 | **拒绝**（`isError`，提示改用 `items_set`） |
| `items_set` 的 `text` 传空串 | 清空这一格（不是删除记录） |
| `items_set` 的 `text` 带 `\r\n` | 归一成 `\n` 再存，行号不会错位 |
| 任一日格 `text` 超过 20000 字符 | 拒绝（上限由数据层把关） |
| `item_line_*` 的 `index` 越界 | 报错并告知「当前共 N 行」 |
| `item_line_set_done` 的 `done` 传 `"false"`（字符串） | **拒绝**（否则会被当成 true） |
| `item_line_move` 的 `from_date === to_date` | **拒绝**（同天移动在数据层会互相覆盖导致丢行） |
| `event_create` 的 `kind=countdown` 缺 `target_date` | 拒绝 |
| `event_create` 的 `kind=countdown` 带 `rrule` | 拒绝（倒数日本身就是持续显示的目标） |
| `events_query` 的 `kind` 非法 | 报错（不会静默返回空数组） |
| `items_query` / `events_query` 的 `from > to` | 报错 |
| `search` / `notes_list` 的 `limit` 非整数或越界 | 报错（`search` 1–200，`notes_list` 1–500） |

## 协议细节（自己写客户端时看）

- **只接受 `POST /mcp`**，且 **`Content-Type: application/json`**（可带 `charset`）。
  其他类型回 `415`；`GET /mcp` 回 `405`（本服务**不提供 SSE 推送流**，`Allow: POST, OPTIONS`）。
- 请求体上限 **1 MB**，超过回 `413`（连接不会被硬掐断）。
- 支持单条与批量（JSON-RPC batch）；空数组按规范判为 `-32600`。
- **通知（没有 `id` 的消息）不产生应答**：`notifications/initialized` 回 `202` 无 body；
  即使是 `tools/call` 形式的通知，也只执行副作用、不回包。
- `initialize` 会按客户端请求的协议版本回显，支持 `2024-11-05 / 2025-03-26 / 2025-06-18`；
  请求了不认识的版本则回最新版。
- 错误码：

  | 情况 | 码 | HTTP |
  |---|---|---|
  | JSON 解析失败 | `-32700` | 400 |
  | 请求结构非法（缺 `jsonrpc`/`method`、`id` 类型错、空批次） | `-32600` | 200 |
  | 方法不存在 | `-32601` | 200 |
  | 参数非法（缺 `name`、`arguments` 非对象、未知工具名） | `-32602` | 200 |
  | 服务端内部异常 | `-32603` | 200 |
  | 工具自身执行失败（日期非法、id 不存在、越界…） | 不是 JSON-RPC error，而是 `result.isError: true` 的 `content` | 200 |
  | 跨源来源被拒 | — | 403 |
  | Content-Type 不对 | — | 415 |
  | 请求体过大 | — | 413 |

  「工具执行失败」走 `isError` 而不是 JSON-RPC error，是 MCP 的约定：模型能读到错误文案并自我纠正。

## 安全模型（本机回环服务，浏览器是最大的攻击面）

1. **只绑 `127.0.0.1`**，不监听 `0.0.0.0`；局域网其他机器连不上（脚本里有断言）。
2. **强制 `Content-Type: application/json`**：浏览器跨源发 JSON 必须先预检，而预检会被拒——
   这就挡住了「任意网页用 `text/plain` 静默写日历」的盲 CSRF。
3. **校验 `Origin`**：带 `Origin` 头的请求必须是 `http://127.0.0.1[:port]` / `http://localhost[:port]` / `http://[::1][:port]`，
   其余（含 `Origin: null`，也就是 `file://` 和沙箱 iframe）一律 `403`；没有 `Origin` 头的（curl、Node、`cal-mcp` 桥）放行。
4. **校验 `Host`**：必须是 `127.0.0.1 / localhost / [::1]`，挡 DNS rebinding。
5. **可选共享令牌**：设置环境变量 `CALDESK_MCP_TOKEN=...` 再启动桌面端，`/mcp`、`/sync/run`、`/migrate/run`
   就要求 `Authorization: Bearer <runtime.json 里的 token>`；`cal` 与 `cal-mcp` 会自动带上，也可用
   `--token` / `CALDESK_TOKEN` 指定。`/health` 不需要令牌（只为探活）。
   默认**不启用**（本机回环 + 上面的 Origin/Content-Type 校验已挡掉网页攻击面）。
6. 所有 SQL 都走 `db.ts` 的参数绑定，`search` 的 `%`/`_` 会被转义；工具层不做任何字符串拼 SQL。

## 最小例子（已实测）

```bash
node caldesk/bin/cal.mjs list                          # 查：视图
node caldesk/bin/cal.mjs add 2026-11-05 "AI 加的一条"   # 增
node caldesk/bin/cal.mjs day 2026-11-05                 # 查：这一天
node caldesk/bin/cal.mjs done 2026-11-05 0              # 改：标记完成
node caldesk/bin/cal.mjs rm 2026-11-05 0                # 删
node caldesk/bin/cal.mjs day 2026-11-05 --json          # 查：结构化输出
```

工具全集在 `src/shared/tools.ts`（20 个），实现在 `src/main/api.ts`。
验收脚本：`node scripts/verify-mcp.mjs`（协议 + 20 工具 + 安全面）、`node scripts/verify-cli.mjs`（CLI 全子命令）。

## AI 配置指南（设置页）

caldesk 桌面端「设置」页面底部有一个 **AI 配置指南** 区块：一段可复制的文本 + 复制按钮。
复制后发给你的 AI Agent，重启 Agent 即可操作日历。

## 常见问题

- **「找不到 caldesk 的运行信息」**：桌面端没开，或 `runtime.json` 路径不对 → 先启动桌面端，
  或设 `CALDESK_RUNTIME` / `CALDESK_URL`。
- **端口是固定的 19283**：一般不用改；如果被占用，设 `CALDESK_MCP_PORT` 环境变量换一个。
- **`415 Content-Type 必须是 application/json`**：客户端没设头，或设成了 `text/plain`/表单类型；补上即可。
- **`403 origin_not_allowed`**：从浏览器页面直接调了这个端口。这是有意的拦截；请改用 `cal-mcp` 桥或 `cal` CLI。
- **手机 / 纯浏览器里能不能用**：不能。MCP 服务只在桌面端主进程里，手机端走服务器 HTTP 接口，没有本地 MCP 端口。
