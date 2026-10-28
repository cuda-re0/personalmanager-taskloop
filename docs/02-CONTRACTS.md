# 02 · 接口契约（IPC + 领域类型）

> 本文件 + `src/shared/**` 是全部接口的**唯一真源**。数据库字段可以内部调整，但跨进程的类型不得擅改。
> 契约冻结前：只有架构负责人可改。冻结后：走变更单。

---

## 1. 全局约定

1. **通道命名**：`<domain>:<action>`，domain ∈ `task | msg | points | ai | reminder | hud | app | bus`。
2. **返回值信封**（所有 `invoke` 一律返回这个形状，异常不 throw，走 `ok:false`）：

```ts
export type Ok<T>  = { ok: true;  data: T };
export type Err    = { ok: false; error: AppError };
export type IpcResult<T> = Ok<T> | Err;

export interface AppError {
  code: AppErrorCode;
  message: string;      // 面向用户的中文短句，可直接渲染
  detail?: string;      // 面向开发者的堆栈/上游响应，仅日志与调试面板显示
  retryable: boolean;
}

export type AppErrorCode =
  | 'DB_ERROR' | 'NOT_FOUND' | 'INVALID_INPUT' | 'CONFLICT'
  | 'AI_NOT_CONFIGURED' | 'AI_UPSTREAM_ERROR' | 'AI_PARSE_FAILED' | 'AI_RATE_LIMITED'
  | 'FILE_TOO_LARGE' | 'UNSUPPORTED_MIME' | 'UNKNOWN';
```

3. **渲染进程只能通过 `window.api` 访问**，`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。preload 用白名单暴露，禁止 `ipcRenderer` 直传。
4. **事件单向**：主进程 → 渲染。渲染进程订阅统一入口 `window.api.onEvent(cb)`，不需要按通道分别订阅。
5. **ID**：`nanoid(12)`，字符串。渲染层不要假设它是数字。
6. **时间**：全部 ISO8601 UTC 字符串；渲染层统一用 `dayjs` 转本地展示。

---

## 2. 领域类型（`src/shared/types/domain.ts`）

```ts
export type TaskType    = 'daily' | 'deadline' | 'event';
export type TaskStatus  = 'todo' | 'doing' | 'reviewing' | 'done' | 'discarded' | 'archived';
export type Difficulty  = 'trivial' | 'easy' | 'medium' | 'hard' | 'epic';
export type Quality     = 'partial' | 'met' | 'exceeded';
export type Priority    = 0 | 1 | 2;
export type NotifyChannel = 'inapp' | 'toast' | 'mail' | 'webhook';
export type ReminderLevel = 'normal' | 'strong';

/** 完成证据（S4 已定） */
export interface Evidence {
  kind: 'text' | 'image';
  text?: string;              // kind='text'
  attachmentId?: string;      // kind='image'，指向 attachments
  addedAt: string;
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  title: string;
  detailMd: string;
  parentId: string | null;
  sortKey: number;
  priority: Priority;
  difficulty: Difficulty;
  estimateMin: number | null;

  /** deadline: 截止时刻 | event: 发生时刻 | daily: null */
  dueAt: string | null;
  /** daily 专用：每日提醒时刻 'HH:mm' */
  dailyTime: string | null;
  /** daily 专用：'DAILY' | 'WEEKLY:1,3,5' | null(=每天) */
  repeatRule: string | null;
  /** daily 专用：区间 YYYY-MM-DD */
  activeFrom: string | null;
  activeTo: string | null;

  /** 相对 dueAt 的分钟偏移，负数提前。deadline 默认 [-1440,-60]，event 默认 [-10080,-4320,-1440] */
  reminderOffsets: number[];
  reminderChannels: NotifyChannel[];

  tags: string[];
  pointsPlanned: number;
  /** deadline/event 才有值；daily 恒为 null，看 occurrences */
  pointsAwarded: number | null;
  quality: Quality | null;

  /** 完成是否必须附证据；由 AI 在建任务时判定，用户可改 */
  requiresEvidence: boolean;
  evidence: Evidence[];

  /** daily 专用 */
  streakCurrent: number;
  streakBest: number;

  source: 'chat' | 'manual' | 'hud';
  aiConfidence: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

/** 创建/更新任务的入参，全部可选 = PATCH 语义 */
export interface TaskPatch {
  title?: string;
  detailMd?: string;
  priority?: Priority;
  difficulty?: Difficulty;
  estimateMin?: number | null;
  dueAt?: string | null;
  dailyTime?: string | null;
  repeatRule?: string | null;
  activeFrom?: string | null;
  activeTo?: string | null;
  reminderOffsets?: number[];
  reminderChannels?: NotifyChannel[];
  requiresEvidence?: boolean;
  tags?: string[];
}

/** 每日任务在某一天的这一次 */
export interface Occurrence {
  id: string;
  taskId: string;
  day: string;                          // YYYY-MM-DD 本地
  status: 'pending' | 'done' | 'skipped' | 'missed';
  pointsAwarded: number | null;
  completedAt: string | null;
  note: string | null;
  /** 联表带出，渲染日历与今日列表时免二次查询 */
  taskTitle?: string;
  taskType?: TaskType;
}

/** 日历一个月的红点索引 */
export interface DayIndexEntry {
  day: string;
  total: number;        // 该日任务总数
  doneCount: number;    // 其中已完成数
}

/** 点某日展开的条目。只含 deadline / event，不含每日任务（Q2 已定） */
export interface DayTaskItem {
  taskId: string;
  type: 'deadline' | 'event';
  title: string;
  time: string;                        // 'HH:mm'，由 dueAt 转本地时刻
  dueAt: string;
  status: 'todo' | 'doing' | 'reviewing' | 'done';
  points: number | null;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageKind = 'text' | 'task_draft' | 'task_review' | 'reminder' | 'error';
export type MessageStatus = 'pending' | 'streaming' | 'sent' | 'failed';

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  kind: MessageKind;
  contentMd: string;
  meta: MessageMeta;         // 按 kind 收窄，见下
  linkedTaskId: string | null;
  status: MessageStatus;
  attachments: Attachment[];
  createdAt: string;
}

export type MessageMeta =
  | { kind: 'none' }
  | { kind: 'task_draft';   drafts: TaskDraft[] }
  | { kind: 'task_review';  taskId: string; verdict: ReviewVerdict }
  | { kind: 'reminder';     reminderId: string; taskId: string | null; title: string; fireAt: string }
  | { kind: 'error';        code: AppErrorCode; message: string; retryable: boolean };

export interface Attachment {
  id: string;
  kind: 'image' | 'file';
  url: string;          // 主进程已转成 `app://attach/<id>` 自定义协议，渲染层直接用
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface PointEntry {
  id: string;
  taskId: string | null;
  occurrenceId: string | null;
  delta: number;
  kind: 'award' | 'penalty' | 'adjust';
  reasonCode: 'task_done' | 'quality_bonus' | 'overdue_penalty' | 'manual_adjust' | 'streak_bonus';
  reasonText: string;
  day: string;          // YYYY-MM-DD 本地
  createdAt: string;
}

export interface Reminder {
  id: string;
  taskId: string | null;
  occurrenceId: string | null;
  offsetMin: number | null;        // null = 绝对时间（每日任务）
  fireAt: string;
  repeatRule: string | null;
  channels: NotifyChannel[];
  level: ReminderLevel;
  status: 'active' | 'fired' | 'paused' | 'cancelled' | 'failed';
  lastFiredAt: string | null;
  firedChannels: NotifyChannel[];
  failReason: string | null;
  createdAt: string;
}

export interface DayStat {
  day: string;          // YYYY-MM-DD
  points: number;
  tasksDone: number;
  tasksCreated: number;
  occurrencesDone: number;
}

export interface TaskDraft {
  /** 客户端生成，用于在同一张草稿卡片内定位（不是数据库 id） */
  localId: string;
  type: TaskType;
  title: string;
  detailMd: string;
  difficulty: Difficulty;
  estimateMin: number | null;
  dueHint: string | null;            // deadline=截止 / event=发生时刻 / daily=null
  dailyTimeHint: string | null;      // 'HH:mm'，仅 daily
  tags: string[];
  steps: DraftStep[];
  missingInfo: string[];             // 信息不足时列出要问用户的点，可能为空
  requiresEvidence: boolean;         // AI 判定这项完成时是否需要证据
  confidence: number;                // 0~1
  pointsPlanned: number;             // 由 rubric 计算填充，AI 不给这个数
}

export interface DraftStep {
  localId: string;
  title: string;
  estimateMin: number | null;
  done: boolean;                     // 确认任务后作为子任务，默认 false
}

export interface ReviewVerdict {
  /** need_evidence = 判断不了，需要用户补证据后再判 */
  verdict: 'pass' | 'partial' | 'fail' | 'need_evidence';
  quality: Quality | null;
  reason: string;                    // 一句话，面向用户
  followup: string | null;           // 证据不足时的追问，可能为 null
}

/** 外部通知通道的可插拔接口，见 §6 */
export interface NotificationChannel {
  id: NotifyChannel;
  /** 是否已配置且可用；false 时调度器跳过该渠道且不报错 */
  available(): Promise<boolean>;
  /** 发送一条提醒；抛错由 reminderService 落到 failReason，不做阻塞式重试 */
  send(payload: ReminderPayload): Promise<void>;
}

export interface ReminderPayload {
  reminderId: string;
  taskId: string | null;
  type: TaskType | null;
  title: string;
  detail: string;        // 一句话摘要，用于 QQ / 邮件正文
  dueAt: string | null;
  offsetLabel: string;   // '前 1 天' / '前 1 小时' / '每日 21:00'
  level: ReminderLevel;
}
```

---

## 3. IPC 方法表（`window.api`）

> 所有方法返回 `Promise<IpcResult<T>>`。下表 `T` 即 `data` 的类型。

### 3.1 `api.app`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `app.getBootstrap` | — | `Bootstrap` | 启动时一次性拉取：settings 摘要、当前任务、余额、最近 30 条消息、今日统计 |
| `app.setSetting` | `{ key: string; value: unknown }` | `void` | 写 settings 并广播 `app.setting.changed` |
| `app.openExternal` | `{ url: string }` | `void` | 仅允许 http/https |
| `app.quit` | — | `void` | |

```ts
export interface Bootstrap {
  tasks: Task[];                 // 限时/活动：status in (todo, doing, reviewing)
  todayOccurrences: Occurrence[]; // 每日任务今日的条目（可能为空）
  messages: Message[];           // 最近 30 条，时间升序
  balance: number;
  today: DayStat;
  monthIndex: DayIndexEntry[];   // 当月日历红点，一次给全
  recentLedger: PointEntry[];    // 最近 20 条明细
  settings: PublicSettings;
  channels: { id: NotifyChannel; available: boolean }[]; // 通知渠道可用性
}
```

### 3.2 `api.task`

| 方法 | 入参 | 返回 `T` |
|---|---|---|
| `task.list` | `{ status?: TaskStatus[]; includeSubtasks?: boolean }` | `Task[]` |
| `task.get` | `{ id: string }` | `Task & { subtasks: Task[] }` |
| `task.promoteDraft` | `{ messageId: string; localId: string; patch?: TaskPatch }` | `Task` |
| `task.update` | `{ id: string; patch: TaskPatch }` | `Task` |
| `task.transition` | `{ id: string; to: TaskStatus; reason?: string }` | `Task` |
| `task.complete` | `{ id: string; quality: Quality; evidence?: Evidence[] }` | `{ task: Task; entry: PointEntry }` | `requiresEvidence=true` 且无 evidence 时返回 `CONFLICT`，不抛异常 |
| `task.addEvidence` | `{ id: string; evidence: Evidence }` | `Task` | 审核中补证据，用于"先追问再补"的来回 |
| `task.setRequiresEvidence` | `{ id: string; value: boolean }` | `Task` | 用户手动改判 |
| `task.reorder` | `{ id: string; beforeId: string \| null }` | `void` |
| `task.createManual` | `{ type: TaskType; title: string; patch?: TaskPatch }` | `Task` |
| `task.remove` | `{ id: string }` | `void` | 软删 → `discarded` |
| `task.setReminderOffsets` | `{ id: string; offsets: number[]; channels?: NotifyChannel[] }` | `Task` | 改完立刻 sync 出 reminders 行 |

`task.transition` 只接受状态机允许的边，非法跳跃返回 `CONFLICT`。`daily` 类型不接受 `reviewing` / `done`。

### 3.2b `api.occurrence`（每日任务）

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `occurrence.today` | — | `Occurrence[]` | 今日所有每日任务条目 |
| `occurrence.listByRange` | `{ from: string; to: string }` | `Occurrence[]` | 日历用；调用前会自动 `ensureRange` 补缺口 |
| `occurrence.complete` | `{ id: string }` | `{ occurrence: Occurrence; entry: PointEntry; streakAfter: number }` | 完成今天这一次，入账 + 更新 streak |
| `occurrence.undo` | `{ id: string }` | `{ occurrence: Occurrence; balanceAfter: number }` | 撤销，写负流水冲销，streak 回退 |
| `occurrence.skip` | `{ id: string; note?: string }` | `Occurrence` | 标记"今天跳过"，不计分、断 streak |

### 3.2c `api.calendar`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `calendar.dayIndex` | `{ year: number; month: number }` | `DayIndexEntry[]` | 一个月红点索引，一次查完，渲染层不再逐日查 |
| `calendar.dayDetail` | `{ day: string }` | `DayTaskItem[]` | 点某日展开的条目，按 time 升序 |

### 3.3 `api.msg`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `msg.send` | `{ text: string; attachmentIds?: string[] }` | `{ userMessage: Message; assistantMessageId: string }` | 立即返回用户消息与占位的 assistant 消息 id，AI 结果通过事件流推送 |
| `msg.retry` | `{ messageId: string }` | `void` | 重跑失败的那一轮 AI |
| `msg.list` | `{ before?: string; limit?: number }` | `Message[]` | 分页向前翻 |

`msg.send` 的流程：写 user 消息 → 广播 → 返回 → 后台跑 AI → 逐条广播 `message.appended` / `message.patch`。渲染层不要 await 到 AI 完成。

### 3.4 `api.ai`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `ai.confirmDraft` | `{ messageId: string; localId: string }` | `Task` | 等价 `task.promoteDraft`，保留单独通道便于埋点 |
| `ai.rejectDrafts` | `{ messageId: string; localIds: string[] }` | `void` | 丢弃草稿卡片 |
| `ai.review` | `{ taskId: string; userText?: string }` | `ReviewVerdict` | 用任务上已存的 `evidence` 审核；不传证据不算审核 |
| `ai.health` | — | `{ configured: boolean; model: string; multimodal: boolean \| null }` | 设置页自检；`multimodal` 靠一次真实调用探测 |

### 3.5 `api.points`

| 方法 | 入参 | 返回 `T` |
|---|---|---|
| `points.balance` | — | `number` |
| `points.ledger` | `{ from?: string; to?: string; limit?: number }` | `PointEntry[]` |
| `points.monthStats` | `{ year: number; month: number }` | `DayStat[]` |
| `points.adjust` | `{ delta: number; reason: string }` | `PointEntry` | 手动调整，`kind='adjust'` |
| `points.preview` | `{ type: TaskType; difficulty: Difficulty; estimateMin: number \| null }` | `number` | 纯计算，无副作用，UI 改难度时实时显示；`type='daily'` 返回单日分值 |
| `points.streakPreview` | `{ current: number; nextDayWillReach: number }` | `number` | 明天完成能拿到的里程碑奖励，0 表示无 |

### 3.6 `api.reminder`

| 方法 | 入参 | 返回 `T` |
|---|---|---|
| `reminder.listByTask` | `{ taskId: string }` | `Reminder[]` |
| `reminder.listUpcoming` | `{ limit?: number }` | `Reminder[]` |
| `reminder.cancel` | `{ id: string }` | `void` |
| `reminder.snooze` | `{ id: string; minutes: number }` | `Reminder` |
| `reminder.syncForTask` | `{ taskId: string }` | `Reminder[]` | 按任务 offsets 重建，幂等 |
| `reminder.testChannel` | `{ channel: NotifyChannel }` | `{ ok: boolean; error?: string }` | 设置页点"测试"，发一条假提醒 |

### 3.7 `api.channel`（外部通知）

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `channel.list` | — | `{ id: NotifyChannel; available: boolean; hint: string }[]` | `hint` 给设置页显示缺失的配置项 |
| `channel.setConfig` | `{ id: NotifyChannel; config: Record<string, string> }` | `void` | 写 settings，敏感值走安全存储 |
| `channel.setGlobal` | `{ channels: NotifyChannel[] }` | `void` | 全局默认渠道 |

### 3.7 `api.hud`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `hud.setMode` | `{ mode: 'dock-bar' \| 'float-pod' }` | `void` | 切换模式，同一窗口重建或缩放宽高 |
| `hud.setExpanded` | `{ expanded: boolean }` | `void` | dock-bar 悬浮展开/收起，由渲染层 hover 触发 |
| `hud.moveTo` | `{ x: number; y: number }` | `void` | float-pod 拖动结束调用，主进程负责 clamp 到可视区域 |
| `hud.setVisible` | `{ visible: boolean }` | `void` | |
| `hud.getState` | — | `{ mode: HudMode; expanded: boolean; displayId: number }` | |

### 3.8 `api.onEvent`（唯一事件入口）

```ts
export type DomainEvent =
  | { type: 'task.created';  task: Task }
  | { type: 'task.updated';  task: Task; changed: (keyof Task)[] }
  | { type: 'task.removed';  taskId: string }
  | { type: 'occurrence.created'; occurrences: Occurrence[] }
  | { type: 'occurrence.updated'; occurrence: Occurrence }
  | { type: 'message.appended'; message: Message }
  | { type: 'message.patch'; messageId: string; patch: Partial<Message> }
  | { type: 'ai.status';     phase: 'thinking' | 'streaming' | 'idle'; messageId?: string }
  | { type: 'points.changed'; balance: number; entry: PointEntry | null; today: DayStat }
  | { type: 'reminder.fired'; reminderId: string; taskId: string | null; title: string; level: ReminderLevel }
  | { type: 'reminder.failed'; reminderId: string; channel: NotifyChannel; reason: string }
  | { type: 'daystats.changed'; day: DayStat }
  | { type: 'app.setting.changed'; key: string; value: unknown }
  | { type: 'channel.status'; channels: { id: NotifyChannel; available: boolean }[] }
  | { type: 'hud.mode.changed'; mode: 'dock-bar' | 'float-pod' };

export type DomainEventType = DomainEvent['type'];
```

规则：

- 任何写操作**必须**至少广播一条事件；没广播 = 另一个窗口不会更新，等于 bug。
- `message.patch` 只允许 patch `contentMd / status / meta`。
- 事件不保证顺序跨类型，但同一实体的事件保序。渲染层以 `task.updated` 的整体对象覆盖本地，不做字段级 merge。
- `occurrence.created` 批量推送（切月补缺口时可能一次几十条），渲染层按数组整体 upsert，不要逐条触发重渲染。

---

## 4. preload 暴露形状

```ts
// src/preload/index.ts
contextBridge.exposeInMainWorld('api', {
  app:        { getBootstrap, setSetting, openExternal, quit },
  task:       { list, get, promoteDraft, update, transition, complete, reorder, createManual, remove, setReminderOffsets, addEvidence, setRequiresEvidence },
  occurrence: { today, listByRange, complete, undo, skip },
  calendar:   { dayIndex, dayDetail },
  msg:        { send, retry, list },
  ai:         { confirmDraft, rejectDrafts, review, health },
  points:     { balance, ledger, monthStats, adjust, preview, streakPreview },
  reminder:   { listByTask, listUpcoming, cancel, snooze, syncForTask, testChannel },
  channel:    { list, setConfig, setGlobal },
  hud:        { setMode, setExpanded, moveTo, setVisible, getState },
  onEvent:    (cb: (e: DomainEvent) => void) => () => void,  // 返回取消订阅函数
});
```

`src/shared/types/ipc.ts` 里同步导出 `export interface Api`（上面这个对象的类型），preload 与渲染层都 `implements Api`，保证两侧不会各写各的。

---

## 5. 积分公式契约（`src/shared/points/rubric.ts`）

**纯函数，主进程与渲染层共用同一份。所有数值来自 `settings['points.*']`，不是硬编码 —— 因为额度要商量，且以后可能调整。**

### 5.1 配置结构

```ts
export interface PointsConfig {
  difficultyBase: Record<Difficulty, number>;
  dailyBase: number;                       // 每日任务单日基础分
  streakBonus: { days: number; bonus: number }[];  // 连续里程碑
  dailyCap: number | null;                 // 日上限，null=不限
}

export const DEFAULT_CONFIG: PointsConfig = {
  difficultyBase: { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
  dailyBase: 1,
  streakBonus: [{ days: 7, bonus: 5 }, { days: 30, bonus: 20 }],
  dailyCap: null,
};
```

### 5.2 限时 / 活动任务

```ts
/** 工作量系数：0 min → 1.0，≥240 min → 1.6，线性 */
export function effortFactor(estimateMin: number | null): number {
  const m = Math.min(Math.max(estimateMin ?? 0, 0), 240);
  return 1 + (m / 240) * 0.6;
}

export function computePlannedPoints(
  d: Difficulty, estimateMin: number | null, cfg = DEFAULT_CONFIG,
): number {
  if (d === 'trivial') return cfg.difficultyBase.trivial;   // trivial 不吃时长系数
  const raw = cfg.difficultyBase[d] * effortFactor(estimateMin);
  return clamp(Math.round(raw), 1, 100);
}

export function computeAwardedPoints(
  planned: number, quality: Quality, overdueDays: number,
): number {
  const q = { partial: 0.6, met: 1.0, exceeded: 1.15 }[quality];
  const penalty = Math.min(overdueDays * 2, 20);
  return clamp(Math.round(planned * q) - penalty, 1, Math.round(planned * 1.2));
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}
```

### 5.3 每日任务（这是需要你拍板的核心）

```ts
/** 完成某一天这一次；返回基础分 + 若达成里程碑则附带的奖励 */
export function computeDailyPoints(
  streakAfter: number, cfg = DEFAULT_CONFIG,
): { base: number; bonus: number; milestoneReached: number | null } {
  const base = cfg.dailyBase;
  const hit = cfg.streakBonus.find(m => m.days === streakAfter) ?? null;
  return { base, bonus: hit?.bonus ?? 0, milestoneReached: hit?.days ?? null };
}
```

**为什么每日任务不能沿用难度分（我的判断，请你确认）：**

| 方案 | 一个月量级（3 个习惯） | 问题 |
|---|---|---|
| 按难度计，easy 每次 10 分 | 900 分 | 直接压垮作业（20 分/次）与考试（35-50 分/次），积分体系失去区分度 |
| 固定低分 1 分/天 + 里程碑 | 约 120 分 | 与"10 次作业 = 200 分"比例约 3:5，两者都算重要事 |
| 不给分，只记连续天数 | 0 分 | 打卡没有即时反馈，很难坚持 |

我倾向第二行。它把"坚持"的价值放在连续天数上，而不是单次分值上 —— 这也符合你把它叫"需要长期坚持的任务"的语义。

### 5.4 额度档位（已定：B 中档）

| 档 | trivial | easy | medium | hard | epic | 每日 | 7 天里程碑 | 30 天 | 一个月典型总分 |
|---|---|---|---|---|---|---|---|---|---|
| A 轻 | 3 | 6 | 12 | 22 | 32 | 1 | +3 | +12 | ≈ 200 |
| **B 中（已采用）** | **5** | **10** | **20** | **35** | **50** | **1** | **+5** | **+20** | **≈ 320** |
| C 重 | 8 | 15 | 30 | 50 | 70 | 2 | +8 | +30 | ≈ 500 |

"一个月典型总分"的算法：10 次作业（平均 medium）+ 2 次考试（hard）+ 3 个每日习惯 × 30 天 + 里程碑。

**为什么每日任务只给 1 分（已确认）**：每日任务是"低成本高频"，限时/活动是"高成本低频"。1 分/天让 3 个习惯一个月贡献约 120 分，与 10 次作业的 200 分形成 3:5 的比例——两者都算重要事，但习惯不靠单次分值取胜，靠"不断"。连续 7 天 +5、30 天 +20 才是它真正的激励所在。

### 5.5 配置来源与生效

- 读 `settings['points.*']`，改配置后**只影响之后新算的分**，历史流水不回算。这是刻意的：积分一旦入账就是事实，回算会让历史账单天天变。
- `points.preview` 用当前配置实时算，所以草稿卡片上显示的分与最终入账一致。
- 日上限 `dailyCap` 若启用：当日累计达到上限后，后续入账按剩余额度截断，并在 `reason_text` 里写明"今日已封顶"。

### 5.6 设计意图（给实现方理解，不要写进 UI 文案）

- AI 只输出 `difficulty` 与 `estimateMin`，**不给分数**。分数由这里算，所以同一个任务无论在哪个窗口看、重算几次，结果一致。
- 上限 100 防止 epic 叠系数失控；下限 1 保证完成即正反馈。
- 历史流水不回算 —— 否则用户改一次配置，过去三个月的账单全部变动，信任直接崩。

---

## 6. 通知渠道契约（R15）

提醒要"醒目"且"不局限于应用内"，所以渠道做成可插拔，而不是在主流程里硬写一个 if。

```ts
// src/main/notify/channels/
export interface ChannelRegistry {
  get(id: NotifyChannel): NotificationChannel;
  listAvailable(): Promise<{ id: NotifyChannel; available: boolean; hint: string }[]>;
}
```

### 6.1 四个渠道的定位

| id | 渠道 | 是否需要配置 | 定位 |
|---|---|---|---|
| `inapp` | 应用内（HUD 高亮 + 会话注入） | 否 | **不可关闭**，保证提醒一定被记录 |
| `toast` | Windows 系统通知 | 否（需系统允许） | 默认开，关掉应用也能看到 |
| `mail` | 邮件 | 是 | **当前主用的外部通道**；发到 QQ 邮箱时手机有提示 |
| `webhook` | 外部推送（通用 POST） | 是 | 接口保留、默认不启用。将来可指向 PushDeer / Server酱 / 企业微信机器人，或你自建的 harness（06 文档） |

**`inapp` 永远执行，其余按任务配置。** 即使外部推送失败，应用内也必须留下这条提醒记录 —— 否则用户在会话里回看不到，等于没提醒。

### 6.2 失败处理

- 每个渠道独立 `try/catch`，一个失败不影响其他渠道。
- 失败写入 `reminders.fail_reason` 与 `fired_channels_json`，并广播 `reminder.failed`。
- 不重试（提醒过时了重试没意义），但要在设置页显示"上次推送失败"。
- 渠道 `available()===false` 时**直接跳过且不报错**，不能因为没配外部推送就让整条提醒失败。

### 6.3 外部提醒方案（已定：**邮件为主，harness 保留想法暂不实施**）

**用户决定（2026-10-28）**：先保留 harness 的想法，不实施；通知走邮箱即可。

**判断标准只有一条：手机能不能弹出通知。** 能弹就算达标，不必执着于是不是 QQ 本体。

| 阶段 | 通道 | 需要你提供什么 | 落地成本 | 手机可感知 | 状态 |
|---|---|---|---|---|---|
| **P0** | `inapp` + `toast` | 无 | 0 | 否（人在电脑前才有用） | **本版必做** |
| **P1** | `mail` → 你的邮箱（QQ 邮箱即可） | 一个收件邮箱地址 | 很低，Agent Mail 已连接 | 是（手机 QQ 邮箱有推送） | **本版必做，当前主用** |
| **P2** | `webhook` → Server酱 / PushDeer / 企业微信机器人 | 一个 URL + 密钥 | 低 | 是 | **接口保留，实现可先不做** |
| **P3** | `webhook` → 自建 harness 的 `/v1/notify` | 跑起 harness（06 文档） | 中 | 是 | **暂缓。设计保留，见 06** |
| **P4** | QQ 开放平台官方机器人 | 开发者注册 + 审核 | 高 | 是 | 不做 |

**结论：W8B 的验收只到 P1。** `webhookChannel` 的接口与配置结构在 §6 里定死（避免以后接的时候改契约），但**实现与验收不作为本版阻塞项**。哪天你想上 harness 或第三方推送，把 URL 填进去就能用，不需要改任何上层代码。

**harness 保留在哪里**：`06-HARNESS.md` 全文保留（代码实测过），但它现在是**参考设计**，不是施工任务。模型调用走 `zhipu` 直连（03 §3.0），提醒走 `mail`。

**因此代码上现在只做三件事**：

1. 把 `NotificationChannel` 接口和注册表做出来（§6），渠道可插拔 —— 这是为了以后接 `webhook` 不用改上层。
2. 实现 `inapp` / `toast` / `mail` 三个渠道。
3. `webhookChannel` 落一个最小实现（URL + method + headers + 可编辑 body 模板），**能跑通 httpbin 即可，不要求接真实服务**。

**通用性设计**：`webhookChannel` 配置长这样，够接绝大多数推送服务，不必为每个服务写适配器。

```jsonc
{
  "url": "https://sctapi.ftqq.com/xxx.send",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "bodyTemplate": {
    "title": "{{title}}",
    "desp": "{{detail}}\n{{offsetLabel}}\n{{dueAt}}"
  }
}
```

模板变量固定五个：`{{title}} {{detail}} {{offsetLabel}} {{dueAt}} {{level}}`。设置页给一个可编辑的 JSON 框，不做花哨表单。

**不能做的事**：不要 hook 本地 QQ 客户端进程、不要逆向协议、不要用非官方 QQ 机器人框架。这类方案随时失效，还会让你账号有风险。

### 6.4 渠道配置存哪

`settings['channel.webhook']` 之类只存**非敏感**字段（URL 主机、收件人）。密钥、Bearer token 一律走 `safeStorage` 加密后单独存，不落 DB 明文，不进日志。

---

## 7. 契约自检清单（每个模块交付前跑一遍）

- [ ] 新增的 IPC 通道是否已登记到 `src/shared/channels.ts`？
- [ ] 返回类型是否落在 `src/shared/types/ipc.ts`，且 `Api` 接口同步更新？
- [ ] 写操作是否广播了 `DomainEvent`？两个窗口是否都更新了？
- [ ] 错误是否转成 `AppError` 而不是抛到渲染层？
- [ ] 是否越权改动了 `src/shared/**`？
