import type {
  Attachment,
  DayIndexEntry,
  DayStat,
  DayTaskItem,
  Difficulty,
  Evidence,
  Message,
  NotifyChannel,
  Occurrence,
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

/** 悬浮形态：顶部贴边条 / 自由浮窗 */
export type HudMode = 'dock-bar' | 'float-pod'

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
  'hud.mode': HudMode
  'hud.displayId': number | null
  'hud.position': { x: number | null; y: number | null }
  'hud.expanded': { 'dock-bar': boolean; 'float-pod': boolean }
  'hud.autoHideFullscreen': boolean
  'points.difficultyBase': Record<Difficulty, number>
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
 */
export type CompleteTaskInput =
  | { id: string; quality: Quality; evidence?: Evidence[]; noPoints?: false }
  | { id: string; noPoints: true; evidence?: Evidence[] }

/* ------------------------------------------------------------------ *
 * §4 preload 暴露形状：window.api 的类型
 * ------------------------------------------------------------------ */

export interface Api {
  app: {
    getBootstrap(): Promise<IpcResult<Bootstrap>>
    setSetting<K extends keyof AppSettings>(input: {
      key: K
      value: AppSettings[K]
    }): Promise<IpcResult<void>>
    openExternal(input: { url: string }): Promise<IpcResult<void>>
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
    send(input: {
      text: string
      attachmentIds?: string[]
    }): Promise<IpcResult<{ userMessage: Message; assistantMessageId: string }>>
    retry(input: { messageId: string }): Promise<IpcResult<void>>
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
  }

  ai: {
    confirmDraft(input: { messageId: string; localId: string }): Promise<IpcResult<Task>>
    rejectDrafts(input: { messageId: string; localIds: string[] }): Promise<IpcResult<void>>
    review(input: { taskId: string; userText?: string }): Promise<IpcResult<ReviewVerdict>>
    health(): Promise<IpcResult<{ configured: boolean; model: string; multimodal: boolean | null }>>
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
    setMode(input: { mode: HudMode }): Promise<IpcResult<void>>
    setExpanded(input: { expanded: boolean }): Promise<IpcResult<void>>
    moveTo(input: { x: number; y: number }): Promise<IpcResult<void>>
    setVisible(input: { visible: boolean }): Promise<IpcResult<void>>
    getState(): Promise<
      IpcResult<{ mode: HudMode; expanded: boolean; displayId: number; visible: boolean }>
    >
  }

  /** 唯一事件入口，返回取消订阅函数 */
  onEvent(cb: (e: DomainEvent) => void): () => void
}
