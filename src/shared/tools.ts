/**
 * MCP 工具定义（元数据）。
 *
 * 与旧版「日历清单」的 items_* / events_* 语义对齐，
 * 但去掉了它那套 pending_confirmation 流程（本应用本地直连，不需要二次确认）。
 *
 * 描述里写清「参数约束」与「返回结构」，AI 侧才能一次调对，不必靠试错。
 */

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

const CALENDAR_ID = {
  type: 'string',
  description: '视图（日历）id，来自 calendar_list；省略则使用第一个视图'
}

const DATE = {
  type: 'string',
  description: '日期 YYYY-MM-DD'
}

/** 行号：必须是 JSON 整数，从 0 开始；null / 字符串会被拒绝（避免静默操作第 0 行） */
const INDEX = {
  type: 'integer',
  minimum: 0,
  description: '行号，从 0 开始（JSON 整数，不要加引号）'
}

const CELL_RESULT = '返回 {calendar_id, date, text, lines}，lines 是整格按行拆开后的数组。'

const RAW_TOOLS: ToolDef[] = [
  {
    name: 'context',
    description:
      '【先调这个】获取日历上下文：今天的日期、默认视图、可用视图数量。用户提到「今天」「明天」「这周」但没给具体日期时，先调这个拿 today 再算日期。返回 {today, default_calendar_id, default_calendar_name, calendar_count, timezone}。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'calendar_list',
    description:
      '列出所有视图（日历）。返回 id、名称、颜色。用户说「有哪些日历/清单」时调用。返回 [{id, name, color}]。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'items_get',
    description:
      '【默认读】读取某一天日格里的普通任务（含完成状态）。用户说「今天有哪些任务」但没有提到重复/提醒/倒数日时，用这个而不是 events_query。' +
      CELL_RESULT,
    inputSchema: {
      type: 'object',
      properties: { calendar_id: CALENDAR_ID, date: DATE },
      required: ['date']
    }
  },
  {
    name: 'items_query',
    description:
      '查询日期范围内的普通任务（日格）。用户说「这周有什么任务」「这几天要做啥」时用这个，不需要一天一天调 items_get。' +
      '范围两端都含；from 晚于 to 会报错。只返回有内容的日格（空日不出现）。返回 [{calendar_id, date, text, lines}]。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        from: { type: 'string', description: '开始日期 YYYY-MM-DD（含）' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'items_append_line',
    description:
      '【默认写】在某天日格末尾追加一条任务。用户说「今天加一条任务：去吃饭」时调用。text 必须是单行（含换行会被拒绝，多行请用 items_set）。' +
      CELL_RESULT,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        text: { type: 'string', description: '单行任务文本，不含换行' }
      },
      required: ['date', 'text']
    }
  },
  {
    name: 'items_set',
    description:
      '整格替换某天的日格内容（多行 Markdown，完成的任务写成 ~~文本~~）。用于批量改写。传空字符串等于清空这一格（不是删除日格记录）。' +
      CELL_RESULT,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        text: { type: 'string', description: '整格文本，可含换行；空串表示清空' }
      },
      required: ['date', 'text']
    }
  },
  {
    name: 'item_line_update',
    description:
      '按行号（从 0 起）修改日格里的一条任务，保留该行原有的完成状态。新文本必须是单行。' + CELL_RESULT,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        index: INDEX,
        text: { type: 'string', description: '新的单行文本' }
      },
      required: ['date', 'index', 'text']
    }
  },
  {
    name: 'item_line_delete',
    description:
      '按行号（从 0 起）删除日格里的一条任务。行号越界会报错并告知当前行数。' + CELL_RESULT,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        index: INDEX
      },
      required: ['date', 'index']
    }
  },
  {
    name: 'item_line_set_done',
    description:
      '把日格里某条任务标为完成或未完成（完成即写成 ~~文本~~）。done 必须是 JSON 布尔值 true/false，字符串 "false" 会被拒绝（它会变成 true）。' +
      CELL_RESULT,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        index: INDEX,
        done: { type: 'boolean', description: 'true=完成，false=取消完成' }
      },
      required: ['date', 'index', 'done']
    }
  },
  {
    name: 'item_line_move',
    description:
      '把日格里的一条任务移到另一天，追加在目标格末尾。用户说「把这个任务挪到明天」时用。from_date 与 to_date 相同时会报错（同天移动会丢行）。' +
      '返回 {moved, from, to}。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        from_date: DATE,
        index: INDEX,
        to_date: DATE
      },
      required: ['from_date', 'index', 'to_date']
    }
  },
  {
    name: 'events_query',
    description:
      '查询时间范围内的事件（重复任务、提醒、倒数日）。范围**两端都含**（闭区间，to 那天的事件也会返回）。用户说「这周有什么事」「有哪些提醒」时用。日格里的普通任务不在这里，用 items_get。' +
      'kind 必须是 all / task / reminder / countdown（其它值报错）。' +
      '注意：倒数日会从开始日到目标日「每天各返回一行」，这些行共用同一个 id，统计时请按 id 去重。' +
      '返回 [{date, id, kind, title, rrule, done, target_date}]。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        from: { type: 'string', description: '开始日期 YYYY-MM-DD（含）' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含），跨度建议不超过 366 天' },
        kind: {
          type: 'string',
          enum: ['all', 'task', 'reminder', 'countdown'],
          description: 'all | task | reminder | countdown，默认 all'
        }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'event_create',
    description:
      '创建事件。kind=task 用于「每周三提醒我」这类重复任务；kind=reminder 用于一次或重复提醒；kind=countdown 用于倒数日（必须给 target_date，且不能带 rrule）。' +
      '返回 {id, title, kind, start, rrule, target_date, remind_minutes}。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        title: { type: 'string', description: '事件标题（1–200 字符）' },
        kind: { type: 'string', enum: ['task', 'reminder', 'countdown'], description: 'task | reminder | countdown' },
        start: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        rrule: {
          type: 'string',
          description: 'RFC5545 重复规则，如 FREQ=WEEKLY;BYDAY=WE 或 FREQ=DAILY;INTERVAL=2'
        },
        target_date: { type: 'string', description: '倒数日目标日期 YYYY-MM-DD' },
        remind_minutes: { type: 'integer', minimum: 0, maximum: 10080, description: '提前提醒分钟数（0–10080）' }
      },
      required: ['title', 'kind', 'start']
    }
  },
  {
    name: 'event_update',
    description:
      '修改已有事件（标题、类型、重复规则、起始日期等）。至少要给一个可改字段，否则报错。' +
      'rrule / target_date 传 null 表示清空。返回 {id, title, kind, start, rrule, target_date}。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '事件 id' },
        title: { type: 'string' },
        kind: { type: 'string', enum: ['task', 'reminder', 'countdown'] },
        start: { type: 'string' },
        rrule: { type: ['string', 'null'], description: '新的重复规则，null 清空' },
        target_date: { type: ['string', 'null'], description: '倒数日目标日期，null 清空' }
      },
      required: ['id']
    }
  },
  {
    name: 'event_delete',
    description: '删除一个事件（含其所有重复发生）。返回 {deleted: id}。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '事件 id' } },
      required: ['id']
    }
  },
  {
    name: 'search',
    description:
      '全文搜索任务、事件与便签。用户问「搜一下关于 X 的内容」时用。limit 是 1–200 的整数（默认 50），非整数会报错。' +
      '返回 [{type: task|event|note, calendarId, calendarName, date, title, lineIndex?, eventId?, noteId?}]。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（不能为空）' },
        calendar_id: CALENDAR_ID,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多返回条数，默认 50' }
      },
      required: ['query']
    }
  },
  {
    name: 'notes_list',
    description:
      '列出便签（标题 + 内容预览），按置顶优先、修改时间倒序。limit 是 1–500 的整数（默认 100）；calendar_id 会按视图过滤。' +
      '返回 [{id, title, preview, pinned, updatedAt, calendar_id}]。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回条数，默认 100' }
      }
    }
  },
  {
    name: 'notes_get',
    description: '读取某条便签的完整内容。返回 {id, title, content, pinned, calendar_id}。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '便签 id' } },
      required: ['id']
    }
  },
  {
    name: 'notes_create',
    description:
      '新建一条便签。content 可以是空串，但标题与内容不能同时为空。返回 {id, title, pinned}。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        title: { type: 'string', description: '标题，可省略' },
        content: { type: 'string', description: '正文' },
        pinned: { type: 'boolean', description: '是否置顶' }
      },
      required: ['content']
    }
  },
  {
    name: 'notes_update',
    description: '修改便签的标题、内容或置顶状态（至少要给一个，否则报错）。返回 {id, title, pinned}。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '便签 id' },
        title: { type: 'string' },
        content: { type: 'string' },
        pinned: { type: 'boolean' }
      },
      required: ['id']
    }
  },
  {
    name: 'notes_delete',
    description: '删除一条便签。返回 {deleted: id}。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '便签 id' } },
      required: ['id']
    }
  }
]

/**
 * 对外暴露的工具表。
 *
 * 在这里统一给每个 inputSchema 补 `additionalProperties: false`，
 * 而不是在 20 个对象里各写一遍——少写一个就会漏一个。
 *
 * 为什么必须是 false：服务端的入参读取是「按名字取，取不到就用默认值」，
 * 所以把 `calendar_id` 误写成 `calendarId` 不会报错，只会静默回落到第一个视图，
 * 于是数据被写进了错误的日历，用户和 AI 都看不到任何异常。
 * 收紧 schema 之后，客户端在发请求前就会拦下来。
 */
export const TOOLS: ToolDef[] = RAW_TOOLS.map((tool) => ({
  ...tool,
  inputSchema: { ...tool.inputSchema, additionalProperties: false }
}))
