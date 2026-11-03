# 云开发接入步骤（你需要操作的部分）

> 目标：让小程序和 PC 端读写**同一套**云开发数据库。
> PC 端走 Cloudflare Worker（管理员权限访问 HTTP API），小程序端走云函数（同样是管理员权限），
> 两端绕过集合权限规则，所以不用纠结"仅创建者可写"这类限制。

## 1. 开通云开发并拿到环境 ID

1. 用微信开发者工具打开 `caldesk/mp/` 目录（AppID 已配置：`wx926dcbdb74c38ab0`）
2. 顶部工具栏点「云开发」→ 按提示开通（选**按量付费**的免费额度即可，不要选包月）
3. 创建环境，名称随便（例如 `caldesk-prod`）
4. 记下**环境 ID**（形如 `caldesk-prod-8gxxxxxx`）——这个可以发我

## 2. 建四个集合

云开发控制台 → 数据库 → 新建集合，逐个创建（名字必须完全一致，区分大小写）：

```
calendars
day_cells
events
notes
```

权限先选「所有用户不可读写」都行——因为两端都用管理员权限，不经过这套规则。

## 3. 建索引（重要）

同步靠 `updatedAt` 做增量拉取，没索引会全表扫：

对 `calendars` / `day_cells` / `events` / `notes` 四个集合，各加一个索引：

- 字段：`updatedAt`，升序
- 字段：`id`，升序（唯一）

## 4. AppSecret 怎么给我

**不要贴在聊天里。** 你本地执行（在 `caldesk/worker/` 目录）：

```powershell
npx wrangler login
npx wrangler secret put WX_APPSECRET
# 回车后粘贴 AppSecret，输入不回显
npx wrangler secret put WX_APPID
npx wrangler secret put TCB_ENV
npx wrangler secret put SYNC_TOKEN
```

`SYNC_TOKEN` 是你自己随便生成的一串（比如 `openssl rand -hex 24` 的结果），
PC 端设置里填同一个即可。

本地调试则把四项写进 `worker/.dev.vars`（该文件已被 .gitignore 排除）。

## 5. 需要发给我的信息

| 信息 | 是否敏感 | 用途 |
|---|---|---|
| 云开发环境 ID | 否，可直接发 | Worker 与云函数的调用目标 |
| Worker 部署后的地址 | 否 | PC 端同步地址 |
| AppSecret | **敏感，不要发** | 你自己 `wrangler secret put` |
| SYNC_TOKEN | **敏感，不要发** | 你自己保管，PC 端填写 |

## 6. 数据模型约定

四个集合的字段与本地 SQLite 一一对应（camelCase），另外每个文档多两个字段：

- `_id`：云开发自动生成，不用管
- `id`：业务主键（与本地一致），同步合并按它匹配
- `updatedAt`：毫秒时间戳，LWW 比较依据
- `deletedAt`：墓碑标记，null 表示未删除

> 注意：云开发默认会给文档加 `_openid`。PC 端写入的文档没有 `_openid`，
> 这不影响同步（两端都用管理员权限），但如果你以后想用「仅创建者可读写」的规则，需要重新设计。
