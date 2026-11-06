# caldesk × AI 控制速查

> 给「想让 AI 直接增添查改日历」的人和 Agent 看。另一篇 `docs/01-给Codex-配置日历MCP.md`、`docs/02-日历清单-AI使用教程.md` 讲的是旧软件「日历清单」，**不是 caldesk**；caldesk 用自己的一套本地服务，看这一篇就够。

## 一句话

caldesk 桌面端一启动，就在 **127.0.0.1 的随机端口**开了一个 MCP 服务；AI 通过它读写日历，改动立刻反映到界面并参与同步。不需要额外开关、不需要插件、不需要联网。

```
AI 软件 / 脚本
   │  MCP (JSON-RPC)
   ▼
caldesk 桌面端内置 MCP 服务  ← %APPDATA%\caldesk\runtime.json 里有端口
   │
   ▼
本机 SQLite + 同步引擎（写操作会广播给所有窗口重读）
```

## 生效前提（三条，缺一不可）

1. **caldesk 桌面端正在运行**（不是手机端、不是浏览器网页版）。
2. 端口写在 `%APPDATA%\caldesk\runtime.json`（Win）/ `~/.config/caldesk/runtime.json`（mac、Linux），每次启动随机，字段 `port`。
3. 想让 AI 直接连，用 `cal-mcp` 桥；只想跑命令，用 `cal` CLI。两者都自动读 runtime.json，不用手抄端口。

验证服务活着：

```bash
node caldesk/bin/cal.mjs list
# 输出视图列表（含每个 id/name/color）就说明通了
```

## 两条接入方式

### A. 把 caldesk 挂成 AI 的 MCP 服务（推荐给 Codex / Claude Desktop / Cursor）

`cal-mcp.mjs` 是 stdio↔HTTP 的桥，日志只走 stderr，不污染协议。

**Codex** — `~/.codex/config.toml`：

```toml
[mcp_servers.caldesk]
command = "node"
args = ["D:/develop/VScode-project/deskD/caldesk/bin/cal-mcp.mjs"]
```

**Claude Desktop** — `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "caldesk": {
      "command": "node",
      "args": ["D:/develop/VScode-project/deskD/caldesk/bin/cal-mcp.mjs"]
    }
  }
}
```

路径换成你本机的实际路径。若桌面端不在默认目录，设环境变量 `CALDESK_RUNTIME` 指向 `runtime.json`，或设 `CALDESK_URL=http://127.0.0.1:<port>` 直接指定。

### B. 命令行（推荐给脚本 / Agent 自己调）

```bash
cal() { node caldesk/bin/cal.mjs "$@"; }   # 或 npm 里的 cal / cal-mcp 两个 bin
```

`--json` 输出原始 JSON，便于 Agent 解析；`--url` 覆盖端口自动发现。

## 增添查改：命令 ↔ MCP 工具对照

| 动作 | CLI | MCP 工具 |
|---|---|---|
| **查**视图列表 | `cal list` | `calendar_list` |
| **查**某天任务 | `cal day 2026-11-05` | `items_get {date, calendar_id?}` |
| **查**事件 | `cal events --from 2026-11-01 --to 2026-11-30 --kind all` | `events_query {from,to,kind}` |
| **查**全文 | `cal search 关键词` | `search {query}` |
| **增**任务行 | `cal add 2026-11-05 买牛奶` | `items_append_line {date,text}` |
| **增**事件 | `cal new-event 站会 --kind task --start 2026-11-06 --rrule "FREQ=WEEKLY;BYDAY=MO"` | `event_create {title,kind,start,rrule?,target_date?}` |
| **改**整段文本 | — | `items_set {date,text}` |
| **改**某一行文字 | — | `item_line_update {date,index,text}` |
| **改**完成 / 取消 | `cal done 2026-11-05 0` / `cal undone 2026-11-05 0` | `item_line_set_done {date,index,done}` |
| **改**事件 | — | `event_update {id,patch}` |
| **删**任务行 | `cal rm 2026-11-05 0` | `item_line_delete {date,index}` |
| **删**事件 | `cal del-event <id>` | `event_delete {id}` |
| **便签**增删查改 | — | `notes_list / notes_get / notes_create / notes_update / notes_delete` |

说明：

- 不带 `calendar_id` 时，默认用**第一个视图**；多视图操作要显式传 `cal list` 里的 id。
- 行号 `index` 从 `0` 开始，是当天任务列表里的顺序，不是数据库 id。
- **写操作会广播**给主窗口和浮窗重读，AI 改完不用手动刷新；只读工具不触发刷新。
- 本机改动会进入同步引擎（每 5 秒探一次水位、后台每 5 分钟全量拉），手机端也能看到。

## 最小例子（已实测）

```bash
node caldesk/bin/cal.mjs list                       # 查：视图
node caldesk/bin/cal.mjs add 2026-11-05 "AI 加的一条"  # 增
node caldesk/bin/cal.mjs day 2026-11-05              # 查：这一天
node caldesk/bin/cal.mjs done 2026-11-05 0            # 改：标记完成
node caldesk/bin/cal.mjs rm 2026-11-05 0              # 删
node caldesk/bin/cal.mjs day 2026-11-05                # 回到空
```

工具全集在 `src/shared/tools.ts`（17 个），实现在 `src/main/api.ts`。

## 常见问题

- **「找不到 caldesk 的运行信息」**：桌面端没开，或 `runtime.json` 路径不对 → 先启动桌面端，或设 `CALDESK_RUNTIME` / `CALDESK_URL`。
- **AI 能连但看不到刚加的日历**：这是旧版本渲染层只重读日格、不重读视图列表导致的，已修复（同步完成后整块重读）。
- **端口是随机的**：每次重启桌面端会变，但 `cal` / `cal-mcp` 都读 runtime.json，配置里不用写死端口。
- **手机 / 纯浏览器里能不能用**：不能。MCP 服务只在桌面端主进程里，手机端走服务器 HTTP 接口，没有本地 MCP 端口。
