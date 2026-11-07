/**
 * 「AI 配置指南」里那段可复制的提示词。
 *
 * 读者是 Agent，不是人，所以每一行都必须和实现逐条对得上：
 *   · 端点 / 协议 / 错误语义  → src/main/api.ts
 *   · 工具名与顺序            → src/shared/tools.ts（这里直接生成，不手打）
 *   · 默认端口                → src/shared/identity.ts
 *
 * 上一版有三处会让 Agent 走弯路，改这版时逐个修掉了：
 *   1. 写着「参数不合法 → JSON-RPC error -32602」，其实工具入参校验全部走
 *      `result.isError`（HTTP 200）；-32602 只出现在协议层（未知工具名、
 *      arguments 不是对象）。照旧文档写，Agent 会把「我参数错了」误判成「工具有问题」。
 *   2. 没写返回结构：`content[0].text` 是一段 JSON **字符串**，要先 parse。
 *   3. 没写日期格式，Agent 会试 `2026/11/7`、`11-07` 这些写法。
 *
 * 长度刻意压在 45 行以内：再长 Agent 反而只读开头。
 */
import { DEFAULT_MCP_PORT } from '@shared/identity'
import { TOOLS } from '@shared/tools'

/** stdio 桥的调用方式（bin/cal-mcp.mjs 是 package.json 里的 bin） */
const STDIO_BRIDGE = 'node caldesk/bin/cal-mcp.mjs'

/** 协议版本协商：服务端只认这三个，其它值回落到最新的一个 */
const PROTOCOL_VERSIONS = '2024-11-05 / 2025-03-26 / 2025-06-18'

export function buildAiGuide(info: { port: number | null; url: string | null }): string {
  const port = info.port ?? DEFAULT_MCP_PORT
  const url = info.url ?? `http://127.0.0.1:${port}/mcp`
  const tools = TOOLS.map((t) => t.name).join(' / ')

  return `我有一个本地待办与日历应用 caldesk，它内置了 MCP 服务。请连接它帮我管理日程。

【连接方式】
HTTP 端点：POST ${url}
请求头必须带 Content-Type: application/json（其它类型服务端直接回 415）
协议：JSON-RPC 2.0；initialize 会协商 ${PROTOCOL_VERSIONS}
stdio 桥：${STDIO_BRIDGE}
服务只监听本机回环；若启动时设了 CALDESK_MCP_TOKEN，HTTP 请求要带 Authorization: Bearer <token>（stdio 桥会自动读取）

【先读后写】
第一次调用先执行 context，拿到 today 和 default_calendar_id。
用户说「今天 / 明天 / 这周」时，先用 today 推算，不要凭训练数据猜当前日期。
所有日期都是本地日历日 YYYY-MM-DD（例：2026-11-07），不带时间、不带时区。

【返回结构】
工具的 content[0].text 是一段 JSON 文本（不是对象），需要先 JSON.parse。
成功时 text 就是数据本身；失败时 result.isError 为 true，text 是中文的失败原因。

【错误语义】
参数不合法（类型不对 / 缺必填 / 越界 / id 不存在）：HTTP 200 + result.isError: true，
原因在 result.content[0].text 里，按提示改参数重试即可，不要放弃。
协议层问题（未知工具名、arguments 不是对象）：才会返回 JSON-RPC error，参数相关问题一般是 code -32602。

【使用规则】
1. 普通待办走 items_*；重复任务 / 提醒 / 倒数日走 events_*；全文查找用 search
2. 写操作请显式传 calendar_id（从 calendar_list 或 context 取）；省略会落到「排序第一」的视图
3. index 从 0 开始，且必须是 JSON 整数 —— 传 "0" 字符串会被拒绝
4. 连续改多行时每轮先 items_get 刷新，否则删掉一行后行号会前移
5. 写操作会自动刷新界面，不需要再调一次读接口确认
6. rrule 用 RFC5545 片段且不写 DTSTART，如 FREQ=WEEKLY;BYDAY=WE、FREQ=DAILY;INTERVAL=2；
   支持 FREQ / INTERVAL / COUNT / UNTIL / BYDAY / BYMONTHDAY，BYMONTH、BYSETPOS、WKST 会被忽略

【边界约定】
· event_update 的 rrule / target_date 传 null 表示清空该字段，不是「不修改」
· 倒数日（kind=countdown）必须给 target_date，且不能同时带 rrule
· item_line_move 的 from_date 与 to_date 相同时会被直接拒绝
· items_append_line 只能追加单行，多行请用 items_set
· events_query 的区间两端都含；倒数日会按天各返回一行、共用同一个 id，统计时按 id 去重
· limit 必须是整数：search 1–200（默认 50），notes_list 1–500（默认 100）

【工具一览（${TOOLS.length} 个，按推荐调用顺序）】
${tools}`
}
