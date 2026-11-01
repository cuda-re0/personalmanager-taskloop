import type {
  Attachment,
  ChatMode,
  DayIndexEntry,
  DayStat,
  DayTaskItem,
  Difficulty,
  EventResult,
  Evidence,
  Memory,
  MemoryKind,
  MemorySource,
  Message,
  NotifyChannel,
  Occurrence,
  Persona,
  PersonaTone,
  PointEntry,
  Quality,
  Reminder,
  ReviewVerdict,
  Task,
  TaskCreatePatch,
  TaskPatch,
  TaskStatus,
  TaskType
} from './domain'
import type { DomainEvent } from './events'

/* ------------------------------------------------------------------ *
 * §1 全局约定：返回值信封 / 错误
 * ------------------------------------------------------------------ */

export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: AppError }
export type IpcResult<T> = Ok<T> | Err

export interface AppError {
  code: AppErrorCode
  message: string // 面向用户的中文短句，可直接渲染
  detail?: string // 面向开发者的堆栈/上游响应，仅日志与调试面板显示
  retryable: boolean
}

export type AppErrorCode =
  | 'DB_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'EVIDENCE_REQUIRED'
  | 'AI_NOT_CONFIGURED'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_PARSE_FAILED'
  | 'AI_RATE_LIMITED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MIME'
  | 'IO_ERROR'
  | 'UNKNOWN'

/* ------------------------------------------------------------------ *
 * §3.1 app.getBootstrap
 * ------------------------------------------------------------------ */

export interface Bootstrap {
  tasks: Task[] // 限时/活动：status in (todo, doing, reviewing)
  todayOccurrences: Occurrence[] // 每日任务今日的条目（可能为空）
  messages: Message[] // 最近 30 条，时间升序
  balance: number
  today: DayStat
  monthIndex: DayIndexEntry[] // 当月日历红点，一次给全
  recentLedger: PointEntry[] // 最近 20 条明细
  settings: PublicSettings
  channels: { id: NotifyChannel; available: boolean }[] // 通知渠道可用性
}

/* ------------------------------------------------------------------ *
 * §3.0 补充类型
 * ------------------------------------------------------------------ */

/**
 * 悬浮形态（04 §5.2 v0.31）：`ball` 132×40 长条 / `panel` 可拉伸面板。
 * 值域与 `hud.mode` 的库里旧值不同——`dock-bar` / `float-pod` / 任何未知串一律按 `ball` 起
 * （见 `hudService.resolveLayout`），不给旧形态留兼容分支。
 */
export type HudMode = 'ball' | 'panel'

/** 面板尺寸（`hud.size`；null = 用默认 360×480） */
export interface HudSize {
  width: number
  height: number
}

/** webhook 渠道配置（非敏感部分；token 存 safeStorage，不在此） */
export interface WebhookConfig {
  url: string
  method: 'POST'
  /** 自定义 header，用于 `Authorization: Bearer <token>` 这类鉴权 */
  headers: Record<string, string>
  /** body 模板，可用变量：{{title}} {{detail}} {{offsetLabel}} {{dueAt}} {{level}} */
  bodyTemplate: string
}

/**
 * settings 表的完整 key 集合，键名与 `01-DATA-MODEL.md` §2.7 逐条对应。
 * **封闭接口**：新增 key 必须先改这里 + 01 §2.7，两边同时改。
 * 表里不含任何密钥（API Key / webhook token 只存 `safeStorage`），因此全量可暴露给渲染层。
 */
export interface AppSettings {
  'ai.provider': { name: 'zhipu'; model: string }
  /**
   * 聊天模型（v0.37，第 18 个 key）：`chat` 管线与记忆提取用它，与上面那个**分开**。
   * 默认 `glm-4.7-flashx`（纯文本、非推理、便宜）；`chatJson` 仍走 `ai.provider.model`。
   */
  'ai.chat.model': string
  'hud.mode': HudMode
  'hud.displayId': number | null
  'hud.position': { x: number | null; y: number | null }
  /** 面板尺寸（v0.30）：`null` = 默认 360×480；球态不写 */
  'hud.size': HudSize | null
  /** 面板背景色 `#rrggbb`（v0.30）：`null` = 取主题 `--bg` */
  'hud.background': string | null
  /** 背景透明度 0.3–1（v0.30，只作用于背景，不加在容器上） */
  'hud.opacity': number
  'hud.autoHideFullscreen': boolean
  'points.difficultyBase': Record<Difficulty, number>
  /**
   * 限时任务的难度基数（v0.54，第 19 个 key）：**仅限时**，缺档回落 `points.difficultyBase`。
   * 只有 `easy` / `medium` / `hard` 会有值（限时的合法难度就这三档）。
   */
  'points.deadlineBase': Partial<Record<Difficulty, number>>
  'points.dailyBase': number
  'points.streakBonus': { days: number; bonus: number }[]
  'points.dailyCap': number | null
  'reminder.quietHours': { from: string; to: string } // 'HH:mm'
  'reminder.channels': NotifyChannel[]
  'channel.mail': { to: string } | null // null = 未配置，渠道 available()=false
  'channel.webhook': WebhookConfig | null
  'app.theme': 'light' | 'dark'
}

/**
 * 渲染层可见的配置投影 = `AppSettings` 全量。
 * **必须有全部字段**：`app.getBootstrap` 返回前要把 DB 里的值与 `DEFAULT_SETTINGS` 合并补齐，
 * 渲染层不应处理 `undefined`。缺 key 视为 W1 的 bug，不是渲染层要兼容的情况。
 */
export type PublicSettings = AppSettings

/**
 * `task.complete` 的两种模式（02 §3.2）。
 *
 * 做成可辨识联合而不是 `noPoints?: boolean`：两种模式一个给 `quality`、一个不给，
 * 用可选开关会同时允许"给了 quality 又声明不计分"，到实现里就变成谁先读谁算数。
 *
 * `result`（v0.19）只在计分分支上：活动的得分由 `resultFactor(result)` 决定，
 * `quality` 对 event 不进公式（02 §5）。给 `deadline` / `daily` 传了一律忽略，不报错。
 */
export type CompleteTaskInput =
  | { id: string; quality: Quality; result?: EventResult; evidence?: Evidence[]; noPoints?: false }
  | { id: string; noPoints: true; evidence?: Evidence[] }

/* ------------------------------------------------------------------ *
 * §4 preload 暴露形状：window.api 的类型
 * ------------------------------------------------------------------ */

/** `points.spendMonth` 的返回（v0.45）：本月支出页一次拿全，不在渲染层拼汇率 */
export interface SpendMonth {
  entries: PointEntry[]
  /** 本月有效支出合计（分） */
  totalCents: number
  /** 当期汇率：1 积分值多少元 */
  rate: number
  /** 该汇率生效的周一（本地日） */
  weekStart: string
}

export interface Api {
  app: {
    getBootstrap(): Promise<IpcResult<Bootstrap>>
    setSetting<K extends keyof AppSettings>(input: {
      key: K
      value: AppSettings[K]
    }): Promise<IpcResult<void>>
    openExternal(input: { url: string }): Promise<IpcResult<void>>
    showMain(): Promise<IpcResult<void>>
    quit(): Promise<IpcResult<void>>
  }

  task: {
    list(input: { status?: TaskStatus[]; includeSubtasks?: boolean }): Promise<IpcResult<Task[]>>
    get(input: { id: string }): Promise<IpcResult<Task & { subtasks: Task[] }>>
    promoteDraft(input: {
      messageId: string
      localId: string
      patch?: TaskCreatePatch
    }): Promise<IpcResult<Task>>
    update(input: { id: string; patch: TaskPatch }): Promise<IpcResult<Task>>
    transition(input: { id: string; to: TaskStatus; reason?: string }): Promise<IpcResult<Task>>
    complete(
      input: CompleteTaskInput
    ): Promise<IpcResult<{ task: Task; entry: PointEntry | null }>>
    /** 24h 内撤销完成（02 §3.2）：非 done 任务按同态 no-op 返回，entry 恒 null */
    undo(input: { id: string }): Promise<IpcResult<{ task: Task; entry: PointEntry | null }>>
    addEvidence(input: { id: string; evidence: Evidence }): Promise<IpcResult<Task>>
    setRequiresEvidence(input: { id: string; value: boolean }): Promise<IpcResult<Task>>
    reorder(input: { id: string; beforeId: string | null }): Promise<IpcResult<void>>
    createManual(input: {
      type: TaskType
      title: string
      patch?: TaskPatch
    }): Promise<IpcResult<Task>>
    remove(input: { id: string }): Promise<IpcResult<void>>
    setReminderOffsets(input: {
      id: string
      offsets: number[]
      channels?: NotifyChannel[]
    }): Promise<IpcResult<Task>>
  }

  occurrence: {
    today(): Promise<IpcResult<Occurrence[]>>
    listByRange(input: { from: string; to: string }): Promise<IpcResult<Occurrence[]>>
    complete(input: {
      id: string
    }): Promise<IpcResult<{ occurrence: Occurrence; entry: PointEntry; streakAfter: number }>>
    undo(input: {
      id: string
    }): Promise<IpcResult<{ occurrence: Occurrence; balanceAfter: number }>>
    skip(input: { id: string; note?: string }): Promise<IpcResult<Occurrence>>
  }

  calendar: {
    dayIndex(input: { year: number; month: number }): Promise<IpcResult<DayIndexEntry[]>>
    dayDetail(input: { day: string }): Promise<IpcResult<DayTaskItem[]>>
  }

  msg: {
    /**
     * `mode` 省略按 `'chat'`（02 §3.3）：模式只由输入区按钮决定，
     * 主进程**不从文本内容推断**。`task` 走 parse 管线出草稿卡，`chat` 走纯文本管线。
     */
    send(input: {
      text: string
      attachmentIds?: string[]
      mode?: ChatMode
    }): Promise<IpcResult<{ userMessage: Message; assistantMessageId: string }>>
    retry(input: { messageId: string }): Promise<IpcResult<void>>
    /**
     * 撤回 / 编辑（v0.48）：删掉这条 user 消息及其引起的后续（到下一个 user 之前），
     * 草稿卡上已确认的任务一并软删。**不广播消息删除事件**，渲染层按 `removedIds` 自己过滤。
     */
    remove(input: {
      messageId: string
    }): Promise<IpcResult<{ removedIds: string[]; removedTaskIds: string[] }>>
    list(input: { before?: string; limit?: number }): Promise<IpcResult<Message[]>>
  }

  attachment: {
    /** 二选一：`sourcePath` 走 copyFile（webUtils 拿到的真实路径），`base64` 走写盘 */
    add(input: {
      name: string
      mime: string
      base64?: string
      sourcePath?: string
    }): Promise<IpcResult<Attachment>>
    /** 按 id 取元数据（v0.36）：审核卡画证据缩略图/角标用，无行 → NOT_FOUND */
    get(input: { id: string }): Promise<IpcResult<Attachment>>
  }

  ai: {
    confirmDraft(input: { messageId: string; localId: string }): Promise<IpcResult<Task>>
    rejectDrafts(input: { messageId: string; localIds: string[] }): Promise<IpcResult<void>>
    review(input: { taskId: string; userText?: string }): Promise<IpcResult<ReviewVerdict>>
    health(): Promise<IpcResult<{ configured: boolean; model: string; multimodal: boolean | null }>>
    /**
     * v0.44（设置抽屉）：`readKey()` 是否拿到 key（env / `userData/ai-key.bin` / 开发期 `.env`）。
     * 与 `health().configured` 同一判据，但**不触发多模态探测**——设置里只是显示一行状态，
     * 不该为此花一次带图请求，也不该让这一行挂在网络往返上。
     */
    keyStatus(): Promise<IpcResult<{ configured: boolean }>>
    /** v0.47：写入 key（`userData/ai-key.bin`，safeStorage 加密），返回写入后重算的状态 */
    setKey(key: string): Promise<IpcResult<{ configured: boolean }>>
  }

  points: {
    balance(): Promise<IpcResult<number>>
    ledger(input: { from?: string; to?: string; limit?: number }): Promise<IpcResult<PointEntry[]>>
    monthStats(input: { year: number; month: number }): Promise<IpcResult<DayStat[]>>
    adjust(input: { delta: number; reason: string }): Promise<IpcResult<PointEntry>>
    preview(input: {
      type: TaskType
      difficulty: Difficulty
    }): Promise<IpcResult<number>>
    streakPreview(input: { current: number; nextDayWillReach: number }): Promise<IpcResult<number>>
    /** v0.45：记账（金额以「分」为单位，汇率由主进程按当期取） */
    spend(input: { amountCents: number; note?: string }): Promise<IpcResult<PointEntry>>
    spendUndo(input: { entryId: string }): Promise<IpcResult<PointEntry>>
    spendMonth(): Promise<IpcResult<SpendMonth>>
  }

  reminder: {
    listByTask(input: { taskId: string }): Promise<IpcResult<Reminder[]>>
    listUpcoming(input: { limit?: number }): Promise<IpcResult<Reminder[]>>
    cancel(input: { id: string }): Promise<IpcResult<void>>
    snooze(input: { id: string; minutes: number }): Promise<IpcResult<Reminder>>
    syncForTask(input: { taskId: string }): Promise<IpcResult<Reminder[]>>
    testChannel(input: {
      channel: NotifyChannel
    }): Promise<IpcResult<{ ok: boolean; error?: string }>>
  }

  channel: {
    list(): Promise<IpcResult<{ id: NotifyChannel; available: boolean; hint: string }[]>>
    setConfig(input: {
      id: NotifyChannel
      config: Record<string, string>
    }): Promise<IpcResult<void>>
    setGlobal(input: { channels: NotifyChannel[] }): Promise<IpcResult<void>>
  }

  hud: {
    /** 手动切换形态（点长条展开 / ESC 收回）：主进程换 bounds + 广播 `hud.mode.changed` */
    setMode(input: { mode: HudMode }): Promise<IpcResult<void>>
    moveTo(input: { x: number; y: number }): Promise<IpcResult<void>>
    /**
     * 长条拖动（04 §5.2.2 v0.32）：`dragBegin` 返回长条当前左上角（屏幕绝对坐标 DIP），
     * 渲染层据此算抓取偏移；`dragTo` 把它移到绝对坐标 `x/y`——
     * `end:false` 只移窗，`end:true` 落 `hud.position` 并在主进程判一次形态。
     * 面板态两者都不参与（面板走 `.hud-head` 的原生拖动）。
     */
    dragBegin(): Promise<IpcResult<{ x: number; y: number }>>
    dragTo(input: { x: number; y: number; end: boolean }): Promise<IpcResult<void>>
    setVisible(input: { visible: boolean }): Promise<IpcResult<void>>
    getState(): Promise<IpcResult<{ mode: HudMode; displayId: number; visible: boolean }>>
  }

  /**
   * 人物卡（v0.37）。`get` 在表空时**就地建默认行**再返回，不报错；
   * `update` 是局部更新，只写传了的字段，长度校验在主进程。
   */
  persona: {
    get(): Promise<IpcResult<Persona>>
    update(input: {
      name?: string
      userCall?: string
      personaMd?: string
      tone?: PersonaTone
    }): Promise<IpcResult<Persona>>
  }

  /**
   * 长期记忆（v0.37）。`list` 按 `updatedAt` 降序，不传 `source` = 全部；
   * `add` 的 `source` 恒为 `'manual'`（主进程写死，渲染层传了也忽略）。
   */
  memory: {
    list(input: { source?: MemorySource }): Promise<IpcResult<Memory[]>>
    add(input: { contentMd: string; kind: MemoryKind }): Promise<IpcResult<Memory>>
    update(input: { id: string; contentMd?: string; kind?: MemoryKind }): Promise<IpcResult<Memory>>
    remove(input: { id: string }): Promise<IpcResult<void>>
  }

  /** 唯一事件入口，返回取消订阅函数 */
  onEvent(cb: (e: DomainEvent) => void): () => void
}
