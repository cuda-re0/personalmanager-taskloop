import type {
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
  | 'AI_NOT_CONFIGURED'
  | 'AI_UPSTREAM_ERROR'
  | 'AI_PARSE_FAILED'
  | 'AI_RATE_LIMITED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MIME'
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

/**
 * 渲染层可见的 settings 投影。
 * 02 文档只写了 `settings: PublicSettings` 没有给出结构，此处不预设任何字段：
 * 具体 key 由 W1 落库、由设置页按需读取（`app.setSetting` 的 key 是开放的）。
 */
export type PublicSettings = Record<string, unknown>

/* ------------------------------------------------------------------ *
 * §3.7 hud 模式（02 文档引用了 HudMode 但未定义）
 * ------------------------------------------------------------------ */

export type HudMode = 'dock-bar' | 'float-pod'

/* ------------------------------------------------------------------ *
 * §4 preload 暴露形状：window.api 的类型
 * ------------------------------------------------------------------ */

export interface Api {
  app: {
    getBootstrap(): Promise<IpcResult<Bootstrap>>
    setSetting(input: { key: string; value: unknown }): Promise<IpcResult<void>>
    openExternal(input: { url: string }): Promise<IpcResult<void>>
    quit(): Promise<IpcResult<void>>
  }

  task: {
    list(input: { status?: TaskStatus[]; includeSubtasks?: boolean }): Promise<IpcResult<Task[]>>
    get(input: { id: string }): Promise<IpcResult<Task & { subtasks: Task[] }>>
    promoteDraft(input: {
      messageId: string
      localId: string
      patch?: TaskPatch
    }): Promise<IpcResult<Task>>
    update(input: { id: string; patch: TaskPatch }): Promise<IpcResult<Task>>
    transition(input: { id: string; to: TaskStatus; reason?: string }): Promise<IpcResult<Task>>
    complete(input: {
      id: string
      quality: Quality
      evidence?: Evidence[]
    }): Promise<IpcResult<{ task: Task; entry: PointEntry }>>
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
      estimateMin: number | null
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
    getState(): Promise<IpcResult<{ mode: HudMode; expanded: boolean; displayId: number }>>
  }

  /** 唯一事件入口，返回取消订阅函数 */
  onEvent(cb: (e: DomainEvent) => void): () => void
}
