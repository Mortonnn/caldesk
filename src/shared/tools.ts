/**
 * MCP 工具定义（元数据）。
 *
 * 与旧版「日历清单」的 items_* / events_* 语义对齐，
 * 但去掉了它那套 pending_confirmation 流程（本应用本地直连，不需要二次确认）。
 */

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
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

export const TOOLS: ToolDef[] = [
  {
    name: 'calendar_list',
    description:
      '列出所有视图（日历）。返回 id、名称、颜色。用户说「有哪些日历/清单」时调用。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'items_get',
    description:
      '【默认读】读取某一天日格里的普通任务（含完成状态）。用户说「今天有哪些任务」但没有提到重复/提醒/倒数日时，用这个而不是 events_query。',
    inputSchema: {
      type: 'object',
      properties: { calendar_id: CALENDAR_ID, date: DATE },
      required: ['date']
    }
  },
  {
    name: 'items_append_line',
    description:
      '【默认写】在某天日格追加一条任务。用户说「今天加一条任务：去吃饭」时调用。text 必须是单行。',
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
      '整格替换某天的日格内容（多行 Markdown，完成的任务写成 ~~文本~~）。用于批量改写。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        text: { type: 'string', description: '整格文本，可含换行' }
      },
      required: ['date', 'text']
    }
  },
  {
    name: 'item_line_update',
    description: '按行号（从 0 起）修改日格里的一条任务。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        index: { type: 'integer', description: '行号，从 0 开始' },
        text: { type: 'string', description: '新的单行文本' }
      },
      required: ['date', 'index', 'text']
    }
  },
  {
    name: 'item_line_delete',
    description: '按行号（从 0 起）删除日格里的一条任务。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        index: { type: 'integer', description: '行号，从 0 开始' }
      },
      required: ['date', 'index']
    }
  },
  {
    name: 'item_line_set_done',
    description: '把日格里某条任务标为完成或未完成（完成即写成 ~~文本~~）。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        date: DATE,
        index: { type: 'integer', description: '行号，从 0 开始' },
        done: { type: 'boolean', description: 'true=完成，false=取消完成' }
      },
      required: ['date', 'index', 'done']
    }
  },
  {
    name: 'events_query',
    description:
      '查询时间范围内的事件（重复任务、提醒、倒数日）。范围左闭右开按本地日期。用户说「这周有什么事」「有哪些提醒」时用。日格里的普通任务不在这里，用 items_get。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        from: { type: 'string', description: '开始日期 YYYY-MM-DD（含）' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD（含），跨度建议不超过 366 天' },
        kind: { type: 'string', description: 'all | task | reminder | countdown，默认 all' }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'event_create',
    description:
      '创建事件。kind=task 用于「每周三提醒我」这类重复任务；kind=reminder 用于一次或重复提醒；kind=countdown 用于倒数日（必须给 target_date，且不能带 rrule）。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        title: { type: 'string', description: '事件标题' },
        kind: { type: 'string', description: 'task | reminder | countdown' },
        start: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        rrule: {
          type: 'string',
          description: 'RFC5545 重复规则，如 FREQ=WEEKLY;BYDAY=WE 或 FREQ=DAILY;INTERVAL=2'
        },
        target_date: { type: 'string', description: '倒数日目标日期 YYYY-MM-DD' },
        remind_minutes: { type: 'integer', description: '提前提醒分钟数（0–10080）' }
      },
      required: ['title', 'kind', 'start']
    }
  },
  {
    name: 'event_update',
    description: '修改已有事件（标题、标题重复规则、起始日期等）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '事件 id' },
        title: { type: 'string' },
        start: { type: 'string' },
        rrule: { type: 'string' },
        target_date: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'event_delete',
    description: '删除一个事件（含其所有重复发生）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '事件 id' } },
      required: ['id']
    }
  },
  {
    name: 'search',
    description:
      '全文搜索任务、事件与便签。用户问「搜一下关于 X 的内容」时用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        calendar_id: CALENDAR_ID,
        limit: { type: 'integer', description: '最多返回条数，默认 50' }
      },
      required: ['query']
    }
  },
  {
    name: 'notes_list',
    description: '列出便签（标题 + 内容预览）。用户说「看看我的便签」时用。',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: CALENDAR_ID,
        limit: { type: 'integer', description: '最多返回条数，默认 100' }
      }
    }
  },
  {
    name: 'notes_get',
    description: '读取某条便签的完整内容。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '便签 id' } },
      required: ['id']
    }
  },
  {
    name: 'notes_create',
    description: '新建一条便签。',
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
    description: '修改便签的标题或内容。',
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
    description: '删除一条便签。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '便签 id' } },
      required: ['id']
    }
  }
]
