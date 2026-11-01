# 02 · 接口契约（IPC + 领域类型）

> 本文件 + `src/shared/**` 是全部接口的**唯一真源**。数据库字段可以内部调整，但跨进程的类型不得擅改。
> 契约冻结前：只有架构负责人可改。冻结后：走变更单。

---

## 1. 全局约定

1. **通道命名**：`<domain>:<action>`，domain ∈ `task | msg | points | ai | reminder | hud | app | occurrence | calendar | attachment | bus`。前十个是 `Api` 上的方法域，`bus` 是单向事件通道（主进程 → 渲染层，`onEvent` 订阅），不在 `Api` 方法集合里。
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
  | 'EVIDENCE_REQUIRED'
  | 'AI_NOT_CONFIGURED' | 'AI_UPSTREAM_ERROR' | 'AI_PARSE_FAILED' | 'AI_RATE_LIMITED'
  | 'FILE_TOO_LARGE' | 'UNSUPPORTED_MIME' | 'UNKNOWN';
```

`EVIDENCE_REQUIRED` 是 v0.9 补的：`deadline` / `event` 在缺证据时 `task.complete` 停在 `reviewing`、不入账（v0.38 起一律按类型判，不再看 `requires_evidence`），这个状态既不是 `CONFLICT`（不是状态冲突，是缺资料）也不是 `INVALID_INPUT`（输入合法，只是不完整）。单列一个码，UI 才能据此把卡片切到"补证据"而不是弹一条通用错误。它与 `retryable: false` 搭配。

3. **渲染进程只能通过 `window.api` 访问**，`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。preload 用白名单暴露，禁止 `ipcRenderer` 直传。
4. **事件单向**：主进程 → 渲染。渲染进程订阅统一入口 `window.api.onEvent(cb)`，不需要按通道分别订阅。
5. **ID**：`nanoid(12)`，字符串。渲染层不要假设它是数字。
6. **时间**：全部 ISO8601 UTC 字符串；渲染层统一用 `dayjs` 转本地展示。

---

## 2. 领域类型（`src/shared/types/domain.ts`）

**本节代码块就是源码契约，`src/shared/types/domain.ts` 与它是同一份东西。** 一致性判据：

> 两者经本项目 `.prettierrc` 格式化后**完全一致（含注释文字）**。

也就是说，差异只允许出现在格式化器管辖的部分——行尾分号、缩进、换行、对齐空格；**字段名、类型、可空性（`null` 而非 `undefined`）、可选性（`?`）、注释文字必须一致**。

为什么这么定义：本文档代码块带分号，而 `.prettierrc` 是 `semi: false`，按字面"逐字"比永远对不上。审核时用 `npx prettier --check src/shared/types/domain.ts` + 机器抽取本文代码块比对，不要用肉眼。

本文档中不出现标记符号。`★` 只出现在 01 的 DDL 与 00 的表格里作为文档层变更标记，抄进代码时删除 `★` 及其后空格。

```ts
export type TaskType    = 'daily' | 'deadline' | 'event';
export type TaskStatus  = 'todo' | 'doing' | 'pending_review' | 'reviewing' | 'done' | 'missed' | 'discarded' | 'archived';
export type Difficulty  = 'trivial' | 'easy' | 'medium' | 'hard' | 'epic';
export type Quality     = 'partial' | 'met' | 'exceeded';
/** 活动任务的结果档（v0.7 起参与积分）；与 Quality 分开：Quality 是"做没做完"，这是"做出什么结果" */
export type EventResult = 'exceeded' | 'met' | 'below';
export type Priority    = 0 | 1 | 2;
export type NotifyChannel = 'inapp' | 'toast' | 'mail' | 'webhook';
export type ReminderLevel = 'normal' | 'strong';

/**
 * 完成证据（S4 已定）。
 * 图片与文件都走 attachment——是截图还是 PDF 由 Attachment.kind 决定，Evidence 不再区分。
 * 早先的 `kind:'image'` 让 `报告.pdf` 这类证据无处表达（04 §3.3 的示例里就有），故改为联合。
 */
export type Evidence =
  | { kind: 'text'; text: string; addedAt: string }
  | { kind: 'attachment'; attachmentId: string; addedAt: string };

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
  /** 小数（2 位）。由 computePlannedPoints 算，不是整数，UI 用 fmtPoints 显示 */
  pointsPlanned: number;
  /** deadline/event 才有值；daily 恒为 null，看 occurrences。同为小数 */
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

/**
 * 创建侧 patch（§3.2 v0.15）：`TaskPatch` 全字段 + 可选 `type`。
 * 只用于 `task.promoteDraft`（确认本质是创建）；`task.update` 仍是 `TaskPatch`，落库后不可改类型。
 */
export interface TaskCreatePatch extends TaskPatch {
  type?: TaskType;
}

/** 每日任务在某一天的这一次 */
export interface Occurrence {
  id: string;
  taskId: string;
  day: string;                          // YYYY-MM-DD 本地
  status: 'pending' | 'done' | 'skipped' | 'missed';
  /** 小数（2 位），未完成为 null */
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
  /** 已完成取实得分 pointsAwarded，未完成取计划分 pointsPlanned；两者都无则 null */
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
  | { kind: 'reminder';     reminderId: string; taskId: string | null; title: string; fireAt: string; offsetMin: number | null }
  | { kind: 'error';        code: AppErrorCode; message: string; retryable: boolean };

**`MessageMeta.reminder.offsetMin` 的写入义务（W8 必须遵守）**：这个字段是**快照**，不是派生值。写提醒消息时，必须把 `reminders.offset_min` 原样拷进 `meta_json`；缺失即视为 `null`（绝对时间，如每日任务按 `dailyTime` 触发）。

之所以不让读取侧现算：`mapMessageMeta(kind, meta_json)` 只拿到一列字符串，join `reminders` 会让纯映射依赖数据库，且消息列表变成 N+1 查询；而 `fireAt - dueAt` 在 `due_at` 改过之后算出来就是错的——提醒是按旧时间发出的，历史消息必须保留当时的偏移。

读取侧只做类型收窄，不猜、不补算。写入侧漏填不会报错，只会静默退化成 `null`，界面上少显示一行「前 1 小时」。

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
  kind: 'award' | 'penalty' | 'adjust' | 'spend';   // v0.45 加 spend
  reasonCode: 'task_done' | 'quality_bonus' | 'overdue_penalty' | 'manual_adjust' | 'streak_bonus' | 'pocket_spend';
  reasonText: string;
  day: string;          // YYYY-MM-DD 本地
  createdAt: string;
  reversedAt: string | null;  // 被冲销的时刻；NULL = 这条发分仍然有效（01 §2.4）
  amountCents: number | null; // v0.45：只有 kind='spend' 有值（整数「分」），其余一律 null，不许塞 0
  fxRate: number | null;      // v0.45：只有 kind='spend' 有值，记账当时的汇率快照
}

/** v0.45：当周汇率。`basis`（AI 评估理由）只进库，不进这个类型 */
export interface FxRate {
  weekStart: string;        // 该汇率生效的周一（本地日）
  rate: number;             // 1 积分值多少元
  source: 'ai' | 'fallback';
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
  dueHint: string | null;            // 三档精度（v0.53，03 §4.1）：
                                     //   'YYYY-MM-DDTHH:mm…' → 到分 / 'YYYY-MM-DD' → 到日 / 'YYYY-MM' → 到月
                                     // daily=null；deadline=截止 / event=发生时刻
                                     // **day/month 必须原样保留**，不许 toISOString()（会把 '2026-11-05'
                                     // 变成 UTC 零点串，等于凭空造出 08:00 的时刻）
                                     // **不要存 '10-30 18:00' 这种无年份形态**：跨年会错一年，
                                     // 而 due_at 同时喂提醒、逾期判定与效率系数三条链路。
                                     // 界面上显示成什么都由渲染层决定（04 §3.2），字段本身只存 ISO 或日期串
                                     // **读侧唯一入口是 `@shared/due` 的 dueInstant / dueLocalDay**，
                                     // 不许自己写 `new Date(dueHint)` / `Date.parse(dueHint)` —— V8 会把
                                     // '10-30 18:00' 静默解析成 2001-10-30，把 '2026-11-05' 当 UTC 零点
  dailyTimeHint: string | null;      // 'HH:mm'，仅 daily
  activeToHint: string | null;       // 'YYYY-MM-DD'，仅 daily 的可选结束日期（04 §3.2 要求此控件）
  reminderOffsets: number[];         // 相对 dueHint 的分钟偏移，负数提前；按 type 默认值填充，用户可改
  tags: string[];
  steps: DraftStep[];
  missingInfo: string[];             // 信息不足时列出要问用户的点，可能为空
  requiresEvidence: boolean;         // v0.38 起不参与审核判定（限时/活动一律要证据）；字段留着只为兼容历史草稿
  confidence: number;                // 0~1
  pointsPlanned: number;             // 小数（2 位）。AI 不给。按 type 分派：
                                     //   daily → settings['points.dailyBase']
                                     //   daily → settings['points.dailyBase']
                                     //   deadline → computePlannedPoints('deadline', difficulty)
                                     //   event    → computePlannedPoints('event', difficulty)
                                     //   **cfg 不许省略**：省了就落到 DEFAULT_CONFIG，用户改过
                                     //   points.difficultyBase 之后卡面与落库会分叉（§5.2b）
                                     // **必须与卡片显示值完全一致**：W5 确认时直接写入
                                     // tasks.points_planned，两套口径会让每日任务变成每天 20 分
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
  /** 仅 type='event' 有意义，其他类型传 null。event 的 quality 恒为 'met'，结果由 result 表达 */
  result: EventResult | null;
  reason: string;                    // 一句话，面向用户
  followup: string | null;           // 证据不足时的追问，可能为 null
  gaps: string[];                    // partial 时逐条列出未完成项，供卡片内展示；其他 verdict 为空数组
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

/** 聊天模式（v0.37）：**只由输入区的模式按钮决定**，禁止从文本内容推断 */
export type ChatMode = 'chat' | 'task';

/** 人物卡语气档（v0.37）。只影响 03 §4.3 里的一句语气指令，不参与任何业务判断 */
export type PersonaTone = 'warm' | 'plain' | 'playful';

/** 人物卡（v0.37）。表支持多张，v1 只有一行 `isActive: true` */
export interface Persona {
  id: string;
  name: string;          // 助手名字，1~20 字
  userCall: string;      // 怎么称呼用户，空串 = 用「你」
  personaMd: string;     // 用户自己写的人设正文，≤ 800 字，原样进 prompt
  tone: PersonaTone;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 记忆分类（v0.37）：profile=我是谁 / preference=我怎么被对待 / fact=可核对的事实 */
export type MemoryKind = 'profile' | 'preference' | 'fact';

/** 记忆来源（v0.37）：auto=模型自动提取，manual=用户手写。存储上完全平等，只用于区分与筛除 */
export type MemorySource = 'auto' | 'manual';

export interface Memory {
  id: string;
  contentMd: string;     // 一条一句话，≤ 120 字，**全局唯一**
  kind: MemoryKind;
  source: MemorySource;
  hits: number;          // 被带进 system prompt 的次数，淘汰依据
  createdAt: string;
  updatedAt: string;
}
```

---

## 3. IPC 方法表（`window.api`）

> 所有方法返回 `Promise<IpcResult<T>>`。下表 `T` 即 `data` 的类型。

### 3.0 补充类型（实现位置：`src/shared/types/ipc.ts`）

§1 的 `Ok` / `Err` / `IpcResult` / `AppError` / `AppErrorCode`，加上本节的 `AppSettings` / `PublicSettings` / `HudMode` / `WebhookConfig`，**实现上都放在 `src/shared/types/ipc.ts`**——`domain.ts` 只放领域实体，不放传输层类型。

（02 早期版本引用了 `PublicSettings` 与 `HudMode` 却没给定义，代码侧曾以 `Record<string, unknown>` 补齐。审核指出这等于放弃 settings 的类型检查，v0.7 改为封闭接口，`ipc.ts` 需按本节同步一次。此后本节即唯一来源。）

```ts
/** 悬浮形态（v0.30）：贴右边缘的球 / 可拉伸的面板 */
export type HudMode = 'ball' | 'panel';

/** webhook 渠道配置（非敏感部分；token 存 safeStorage，不在此） */
export interface WebhookConfig {
  url: string;
  method: 'POST';
  /** 自定义 header，用于 `Authorization: Bearer <token>` 这类鉴权 */
  headers: Record<string, string>;
  /** body 模板，可用变量：{{title}} {{detail}} {{offsetLabel}} {{dueAt}} {{level}} */
  bodyTemplate: string;
}

/**
 * settings 表的完整 key 集合，键名与 `01-DATA-MODEL.md` §2.7 逐条对应。
 * **封闭接口**：新增 key 必须先改这里 + 01 §2.7，两边同时改。
 * 表里不含任何密钥（API Key / webhook token 只存 `safeStorage`），因此全量可暴露给渲染层。
 */
export interface AppSettings {
  'ai.provider': { name: 'zhipu'; model: string };
  'ai.chat.model': string;                                        // v0.37 新增：闲聊模型（强制思考），默认 'glm-4.7-flashx'
  'hud.mode': HudMode;                                            // v0.30：'ball' | 'panel'
  'hud.displayId': number | null;
  'hud.position': { x: number | null; y: number | null };          // ball 只存 y（x 锁右边缘），panel 存 x/y
  'hud.size': { width: number; height: number } | null;            // v0.30 新增：panel 拉伸后的尺寸，null = 默认 360×480
  'hud.background': string | null;                                 // v0.30 新增：null = 跟随主题 --bg
  'hud.opacity': number;                                           // v0.30 新增：0.3–1，默认 1，只作用于背景
  'hud.autoHideFullscreen': boolean;                              // 保留 key，本轮不实现检测（v0.17 降级，见 04 §5.6）
  'points.difficultyBase': Record<Difficulty, number>;             // 活动 / 每日 用的共用表
  'points.deadlineBase': Partial<Record<Difficulty, number>>;      // v0.54（第 19 个 key）：**仅限时**
                                                                   // 缺档回落 points.difficultyBase
  'points.dailyBase': number;
  'points.streakBonus': { days: number; bonus: number }[];
  'points.dailyCap': number | null;
  'reminder.quietHours': { from: string; to: string };   // 'HH:mm'
  'reminder.channels': NotifyChannel[];
  'channel.mail': { to: string } | null;                 // null = 未配置，渠道 available()=false
  'channel.webhook': WebhookConfig | null;
  'app.theme': 'light' | 'dark';
}

/**
 * 渲染层可见的配置投影 = `AppSettings` 全量。
 * **必须有全部字段**：`app.getBootstrap` 返回前要把 DB 里的值与 `DEFAULT_SETTINGS` 合并补齐，
 * 渲染层不应处理 `undefined`。缺 key 视为 W1 的 bug，不是渲染层要兼容的情况。
 */
export type PublicSettings = AppSettings;
```

`Difficulty` 与 `NotifyChannel` 从 `domain.ts` 引入，`ipc.ts` 可以 import，不算循环依赖（`domain.ts` 不反向引用 `ipc.ts`）。

**关于 `AppSettings` 的 key 数量**：01 §2.7 列出 18 条，本节定型 **18 条**（v0.37 起；v0.30 时是 17 条，新增的一条是 `ai.chat.model`）。少的那条是 `ai.apiKey`——它存 `safeStorage`、不入 settings 表，因此不进类型，也不在 01 §2.7 的 key 表里。这不是漏写；反过来，密钥因此不可能出现在 IPC 载荷上。

**`ai.apiKey` 的读取优先级（v0.22）**：`safeStorage` 文件 > `process.env.ZHIPU_API_KEY`（开发期由 `.env.local` 提供，该文件已被 gitignore）> 未配置（`ai.health` 返回 `configured: false`，`ai.*` 调用返回 `AI_NOT_CONFIGURED`）。**v0.47 起推翻"不提供界面输入"**：设置抽屉的 AI 块最下一行是密码框 + `[保存]`，走 `ai.setKey` → `aiService.setKey` → `writeKey()`（`userData/ai-key.bin`，safeStorage 加密）。`config.ts` 自身仍不注册通道。写入后 `readKey()` 立即读到新值，**不需要重启**。详见 `03-AI-CONTRACT.md` §9.7。

**`Bootstrap.channels` 在 W9（外部通知渠道）落地前恒为 `[]`。** 不许为了凑形状返回一个 `available: true` 的假渠道——那会让设置页显示"可用"，用户配完发不出任何通知。

**本节代码块一旦被施工方抄走，就不再改动其内部注释。** 需要补充说明时写在代码块外（就像上面这段），否则每个抄过旧版的施工方都会被判"与文档不一致"。这是本项目已实际踩过的坑。

### 3.1 `api.app`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `app.getBootstrap` | — | `Bootstrap` | 启动时一次性拉取：settings 摘要、当前任务、余额、最近 30 条消息、今日统计 |
| `app.setSetting` | `{ key: K; value: AppSettings[K] }`，其中 `K extends keyof AppSettings` | `void` | 写 settings 并广播 `app.setting.changed`。**key 封闭**：写未登记的 key 编译期即报错 |
| `app.openExternal` | `{ url: string }` | `void` | 仅允许 http/https |
| `app.showMain` | — | `void` | v0.46：叫出主窗。隐藏/最小化 → `restore + show + focus`；已被 `×` 关掉 → 重建一个。**不广播、不落库、无返回数据**，纯窗口动作。与 `second-instance` 共用同一个 `showMainWindow()` |
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
| `task.promoteDraft` | `{ messageId: string; localId: string; patch?: TaskCreatePatch }` | `Task` | 同一 draft 重复确认返回已生成的原 Task（幂等），不重复落库 |
| `task.update` | `{ id: string; patch: TaskPatch }` | `Task` |
| `task.transition` | `{ id: string; to: TaskStatus; reason?: string }` | `Task` | 合法边见 01 §3。**v0.38**：点完成先到 `pending_review`（待提交），卡片上点「提交」才到 `reviewing`；`pending_review` 停留超 10 分钟由主进程自动退回 `doing` |
| `task.complete` | `CompleteTaskInput`（见下） | `{ task: Task; entry: PointEntry \| null }` | **v0.38**：`deadline`/`event` 无 evidence 时抛 `EVIDENCE_REQUIRED`，任务停在 `reviewing`、不入账（不再看 `requires_evidence`）。**v0.34：调用方必须先走 `ai.review` 再按结论调用本通道**（只有 `pass` 才调）；主进程不做这个约束——它只管「状态 + 闸门 + 入账」三件事 |
| `task.undo` | `{ id: string }` | `{ task: Task; entry: PointEntry \| null }` | 24h 内撤销完成：`done → doing` + 原发分行标 `reversed_at` + 写等额负流水（01 §2.4） |
| `task.addEvidence` | `{ id: string; evidence: Evidence }` | `Task` | 审核中补证据，用于"先追问再补"的来回。**v0.38：`pending_review` 下也允许**（这就是"先传材料再提交"的正常路径） |
| `task.setRequiresEvidence` | `{ id: string; value: boolean }` | `Task` | **v0.38 起失效**：审核一律要求证据，本通道保留注册但不再改变任何行为（01 §3 证据闸门）。新代码不许调用 |
| `task.reorder` | `{ id: string; beforeId: string \| null }` | `void` |
| `task.createManual` | `{ type: TaskType; title: string; patch?: TaskPatch }` | `Task` |
| `task.remove` | `{ id: string }` | `void` | 软删 → `discarded` |
| `task.setReminderOffsets` | `{ id: string; offsets: number[]; channels?: NotifyChannel[] }` | `Task` | 改完立刻 sync 出 reminders 行 |

`task.transition` 只接受状态机允许的边，非法跳跃返回 `CONFLICT`。`daily` 类型不接受 `reviewing` / `done`。

**`to='done'` 一律 `CONFLICT`，包括对已完成任务的重复调用。** 完成必须在**同一个事务**里写 `completed_at` + `points_awarded` + `point_ledger`（01 §3），`transition` 只改状态，走过去就会造出"已完成但从未入账"的任务，`daily_stats.tasks_done` 也计不到。这里刻意**不做**幂等 no-op：完成只有 `task.complete` 一个入口，重复调用应当报错而不是假装成功。

**`noPoints: true` 是不计分出口**（04 §3.3 的「直接标记完成（不计分）」）。它不是后门，是防死锁：连续 3 次 `need_evidence` 后用户仍需能把这件事收尾。语义固定为——写 `completed_at`、`status='done'`、累加 `daily_stats.tasks_done`，**不写 `point_ledger`、`points_awarded` 保持 NULL**；返回的 `entry` 为 `null`。事务边界与正常完成完全一致，只是少了入账两步。调用方拿 `entry === null` 判断"这次没给分"，不要再用别的字段推断。

```ts
/** 两种模式做成可辨识联合：给了 quality 就是计分，noPoints 就是不计分，不许两个都写 */
export type CompleteTaskInput =
  | {
      id: string
      quality: Quality
      /** 仅 event 生效（v0.19）：活动的结果档参与 resultFactor；其他类型传了忽略 */
      result?: EventResult
      evidence?: Evidence[]
      noPoints?: false
    }
  | { id: string; noPoints: true; evidence?: Evidence[] }
```

**`result` 只对 `event` 有意义**（02 §5）：活动的 `quality` 不进公式（`q` 恒 1），得分完全由 `resultFactor(result)` 决定——`exceeded` ×1.2、`below` ×0.85、未给 ×1.0。不给 `result` 时活动恒按 ×1.0 结算（这是"没有结果信息"的合法值，不是缺省 bug）。`deadline` / `daily` 传 `result` 一律忽略，不报错。

**证据闸门抛 `EVIDENCE_REQUIRED`，不是 `CONFLICT`。** 缺证据既不是状态冲突（状态是对的，停在 `reviewing`）也不是输入格式错（输入合法，只是不完整），所以 v0.9 就单列了这个码（§1）——UI 要据此把卡片切到"补证据"而不是弹一条通用错误。实现与契约此前不一致（代码抛 `CONFLICT`、04 §1.1 又把它登记在 `INVALID_INPUT` 名下），v0.19 统一为 `EVIDENCE_REQUIRED`。

**`task.undo` 是撤销完成的唯一入口**（01 §3 的 `done ──24h 内撤销──→ doing`）：

- 只有 `status === 'done'` 才可撤销；不是 `done` 时按同态 no-op 返回（不报错、不写库）——与 `transition` 的幂等口径一致。
- **窗口 24 小时**：`completed_at` 距今超过 24h 报 `CONFLICT`「超过 24 小时的完成记录不能撤销」。窗口外的分已进当日统计与 streak，回退会连带改写已经"结账"的历史。`daily` 的撤销走 `occurrence.undo`，不吃这个窗口（当天打卡天然在 24h 内）。
- 撤销三件事同一事务：状态回 `doing`、原 `task_done` 行标 `reversed_at`、写等额负流水；`points_awarded` / `quality` / `completed_at` 清空，`daily_stats.tasks_done` 在**原完成日**减 1。
- `noPoints` 完成的任务没有流水可冲，`entry` 返回 `null`，只回状态。
  **已知限制（v0.20 登记）**：这类任务在 ④ 里没有可点的行（④ 是流水，无流水无行），① 又只列未完成任务（04 §4①），所以**当前没有 UI 入口**，通道能调、界面调不到。不补入口的理由：无分可退，误操作代价仅是任务变 `done`，而 24h 撤销窗口本来就是为"退分"设的；若 W10 打磨时要补，位置得先定（在 ① 里塞已完成行会推翻 04 §4① 的分工）。
- **广播**（v0.20 写明）：非 `done` 的调用是同态 no-op，零写入零广播；实际撤销时推 `task.updated` + `points.changed`（`entry` 可为 `null`）+ `daystats.changed`——冲销行落在今天，而 `tasks_done` 减在**原完成日**，两天都要推（相邻日推一条，跨日推两条）。照 `occurrence.undo` 的既有做法。
- **撤销后可以重做**：唯一索引的谓词带 `reversed_at IS NULL`（01 §2.4），重做时新插的发分行不会撞上已冲销的旧行。但**任务本身要先走回 `reviewing` 才能再次 `task.complete`**——`done → done` 仍然一律 `CONFLICT`（状态机没变）。

**`TaskPatch` 没有 `type`，落库后不支持改类型。** 04 §3.2 那句"类型可就地修改"说的是**草稿卡片**（还没落库的 `TaskDraft`，纯渲染层状态）；右栏任务详情（04 §4①）只有 `detail_md` / 步骤勾选 / 提醒偏移 / `[完成]` 四项，本来就没有类型入口。任务一旦落库，类型不可改——要换类型就 `task.remove`（软删 → `discarded`）再建一条，旧任务连同它的流水与 occurrence 一起留在历史里。

**不要给 `TaskPatch` 加 `type`。** 改类型会连带四件事：难度要 `snapDifficulty` 归位、目标类型不适用的字段（`due_at` / `daily_time` / `repeat_rule` / `active_*`）要清、`reminders` 行要按新类型重排、切到每日后当天的 occurrence 要补。其中重排提醒依赖 W8 的同步逻辑，现在做只会留下"按旧类型排好的提醒"——那比不能改类型糟得多。

**`promoteDraft` 的 `patch` 用创建侧形状 `TaskCreatePatch`：`TaskPatch` 的全部字段 + 可选 `type`。** draft 尚未落库，"落库后不可改类型"约束的是 update 链路；确认本质是创建，`createTask` 本来就收 type，允许用户在确认那一刻定类型。主进程收到 `type` 时：按新 type 落库，`pointsPlanned` 按新 type 口径重算（`daily` 恒 `cfg.dailyBase`，`deadline` / `event` 走 `computePlannedPoints(type, difficulty, cfg)`），due 字段按 type 映射（`daily` → `daily_time`/`repeat_rule`/`active_from`，否则 → `due_at`）；非法 type×difficulty 照旧只拒 `INVALID_INPUT`、不归位——草稿卡就地改 type 时渲染层 `applyDraftPatch` 已做过 `snapDifficulty`，正常路径到主进程必然合法。落库之后依旧不可改：`task.update` 的 `TaskPatch` 没有也不许有 `type`。

### 3.2b `api.occurrence`（每日任务）

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `occurrence.today` | — | `Occurrence[]` | 今日所有每日任务条目 |
| `occurrence.listByRange` | `{ from: string; to: string }` | `Occurrence[]` | 日历用；调用前会自动 `ensureRange` 补缺口 |
| `occurrence.complete` | `{ id: string }` | `{ occurrence: Occurrence; entry: PointEntry; streakAfter: number }` | 完成今天这一次，入账 + 更新 streak |
| `occurrence.undo` | `{ id: string }` | `{ occurrence: Occurrence; balanceAfter: number }` | 撤销，写负流水冲销，streak 回退 |
| `occurrence.skip` | `{ id: string; note?: string }` | `Occurrence` | 标记"今天跳过"，不计分、断 streak |

**`occurrence.today` / `listByRange` 是"读起来像读、实际会写"的通道。** 两者内部都会 `ensureRange` 补当天/区间的行，所以它们**必须广播 `occurrence.created`**（携带真正新建的那几条）。做法：调用前后各 `listRangeRaw` 一次、按 id 求差集，不要为了省一次查询而改成不广播——另一个窗口的今日列表就靠这条事件刷新。`app.getBootstrap` 例外：它返回的就是当前全量快照，不广播。

**`task.promoteDraft` 的广播另有一条硬约束（v0.21）**：daily 草稿落库时会 `ensureRange(今天, +3天)` 预生成 4 天 occurrence（后续日历/提醒按需补齐用），但这 4 条**只广播今天那一条**。原因是 `occurrence.created` 的消费者会把载荷 upsert 进「今日列表」（右栏① / HUD），未来日期混进去就变成同一任务 4 行；用户逐个点掉就是给未来三天提前打卡、白拿分、streak 也被推到 4（2026-10-29 实测事故）。同时渲染层的两个 hook 必须各自按 `day === today` 再过滤一次——事件通道对任何调用方开放，不能只指望生产方守规矩，`groupTasks` 里也要再兜一道。

### 3.2c `api.calendar`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `calendar.dayIndex` | `{ year: number; month: number }` | `DayIndexEntry[]` | 一个月红点索引，一次查完，渲染层不再逐日查 |
| `calendar.dayDetail` | `{ day: string }` | `DayTaskItem[]` | 点某日展开的条目，按 time 升序 |

### 3.3 `api.msg`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `msg.send` | `{ text: string; attachmentIds?: string[]; mode?: ChatMode }` | `{ userMessage: Message; assistantMessageId: string }` | 立即返回用户消息与占位的 assistant 消息 id，AI 结果通过事件流推送 |
| `msg.retry` | `{ messageId: string }` | `void` | 重跑失败的那一轮 AI |
| `msg.list` | `{ before?: string; limit?: number }` | `Message[]` | 分页向前翻。**排序是全序**：同毫秒落库的消息按落库序返回（`created_at` 只有毫秒精度，平手由插入序裁决，对渲染层透明）、游标跨毫秒对不丢不重；`before` 是消息 id，查不到报 `NOT_FOUND`「分页游标消息不存在」 |

`msg.send` 的流程：写 user 消息 → 广播 → 返回 → 后台跑 AI → 逐条广播 `message.appended` / `message.patch`。渲染层不要 await 到 AI 完成。

**`mode`（v0.37）**：`'chat'` 走纯文本闲聊管线（03 §4.3，用 `ai.chat.model`），`'task'` 走现有 parse 管线（03 §4.1，用 `ai.provider.model`，出草稿卡）。**省略时按 `'chat'` 处理**——旧调用方（测试、脚本）不该因为多了这个字段就变成另一条链路。`mode` 只由界面按钮给出，主进程**不许**再从文本内容推断（曾经设计过「以『建任务』开头」的关键词判定，v0.37 撤销：按钮已经明确了用户意图，再猜一遍只会产生两份真值且互相打架）。

- `mode='chat'` 时 `attachmentIds` 仍会被写入消息的附件关系，但**不进 prompt**——`ai.chat.model`（`glm-4.7-flashx`）是纯文本模型，送图会直接报错。用户选了图还是发了，是他的自由，不拦、不提示、不置灰按钮。
- `mode='task'` 时图片照现有 `03 §5` 管线压缩后送模型，一行不改。

### 3.3b `api.attachment`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `attachment.add` | `{ name: string; mime: string; base64?: string; sourcePath?: string }` | `Attachment` | `base64` 与 `sourcePath` 二选一，都给以 `sourcePath` 为准；都不给是 `INVALID_INPUT` |
| `attachment.get` | `{ id: string }` | `Attachment` | **v0.35 新增**：只回元数据（`id/kind/url/mime/bytes/width/height`），不回字节。查不到与 id 形状不合法同为 `NOT_FOUND` |

> **v0.35 接线状态**：`attachment.add` 此前只在 preload 声明、主进程**没有注册 handler**（一直在 `NOT_WIRED` 里挂 W11 名下），渲染层调用会收到 "No handler registered"。v0.35 起两条一起真正注册。`attachment.get` 是证据卡片渲染已有附件（缩略图 / 类型角标）的唯一入口——`Evidence` 只存 `attachmentId`，没有 mime 与 url。

**这是唯一一个"把字节搬进系统"的入口。** 其余所有涉及附件的路径（消息、证据）都只传 `attachmentId`，不传文件本身。

- **落盘位置**固定 `userData/attachments/YYYY/MM/<id>.<ext>`，`<ext>` 由 **mime 推导**，不用用户给的文件名——文件名只用于日志，绝不参与拼路径。
- **去重**：按 `(sha256, mime)` 查 `idx_attachments_sha`，命中则复用同一个 `rel_path`、**新插一行**（一条记录一个 id，能各自独立删）。物理文件 v1 **只增不删**：删消息只删行不删文件，避免共享文件被连带删除；磁盘代价按截图/PDF 量级可接受。
  - 键里必须带 `mime`：只看 `sha256` 的话，同一份字节被声明成两种 mime 会复用第一次的扩展名（`...png`）而新行记第二种 mime，路径与 `Content-Type` 长期不一致。多存一个文件，换掉一个说不清的例外。
- **上限与白名单**：单文件 ≤ 25 MiB，mime ∈ `image/png` `image/jpeg` `image/webp` `image/gif` `application/pdf`，越界返回 `FILE_TOO_LARGE` / `UNSUPPORTED_MIME`（这两个码此前一直没人用）。
- **`url` 由主进程拼**：`app://attach/<id>`，不在渲染层拼字符串。协议处理器只接受 `id`，**路径从数据库的 `rel_path` 取，绝不接受调用方传路径**；id 不匹配 `nanoid(12)` 形状或查不到行一律 404。
- **协议注册时序**：`registerSchemesAsPrivileged` 必须在 `app.whenReady()` 之前调用（Electron 33 要求，否则 `secure`/`stream` 标志不生效），`protocol.handle('app', …)` 在 ready 之后。`Content-Type` 取行的 `mime`。
  - **`Content-Disposition`：PDF 发 `inline`，图片不发送这个头。** 不要写 `default`——RFC 6266/2183 只认 `inline` / `attachment`，`default` 是无效 token，Chromium 直接忽略，等于没写。
- **给 AI 的读取**：`attachment.read(id) → { bytes: Buffer; mime: string }` 是主进程内部函数，**不暴露成 IPC**。W4 组多模态请求时用它取 base64，渲染层拿不到原始字节。id 形状不合法与查不到行一样返回 `NOT_FOUND`（不在读盘前区分两种失败）。
- **磁盘失败用 `IO_ERROR`**：写盘/读盘失败（磁盘满、权限、目标被删）返回 `IO_ERROR`，不要借用 `DB_ERROR` 或 `UNKNOWN`——前者误导排查方向，后者会被当成程序缺陷。
- **`width` / `height` v1 留 `null`**：不引入图片解码依赖。UI 不要靠尺寸占位（会抖动），要占位就先定宽高比容器。

### 3.4 `api.ai`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `ai.confirmDraft` | `{ messageId: string; localId: string }` | `Task` | 等价 `task.promoteDraft`，保留单独通道便于埋点 |
| `ai.rejectDrafts` | `{ messageId: string; localIds: string[] }` | `void` | 丢弃草稿卡片 |
| `ai.review` | `{ taskId: string; userText?: string }` | `ReviewVerdict` | 用任务上已存的 `evidence` 审核；不传证据不算审核 |
| `ai.health` | — | `{ configured: boolean; model: string; multimodal: boolean \| null }` | 设置页自检；`multimodal` 靠一次真实调用探测 |
| `ai.keyStatus` | — | `{ configured: boolean }` | **v0.44 新增**。只要 key 在不在，**不发网络请求、不做多模态探测**。判据与 `ai.health().configured` 同源（`readKey()` 拿到值），设置抽屉那行状态用它，不用 `health`——为显示一行字去真发一次带图请求不划算，且 `health` 要等探测结果才返回 |
| `ai.setKey` | `{ key: string }`（上限 200） | `{ configured: boolean }` | **v0.47 新增**。唯一副作用是写 `userData/ai-key.bin`（safeStorage 加密）：不广播、不落库、不发网络请求、不触发任何 AI 管线。返回**写入后重算**的 `configured`（不硬编码 `true`）。空串 → `INVALID_INPUT`「API Key 不能为空」；加密不可用 → `INVALID_INPUT`「API Key 保存失败」（**拒绝落明文**，无回滚、无备份旧 key）。守卫只拦类型与 200 上限，**不写 `.min(1)`**——空串的可读文案归 service。**任何日志/错误 detail 里不许出现 key** |

### 3.5 `api.points`

| 方法 | 入参 | 返回 `T` |
|---|---|---|
| `points.balance` | — | `number` |
| `points.ledger` | `{ from?: string; to?: string; limit?: number }` | `PointEntry[]` |
| `points.monthStats` | `{ year: number; month: number }` | `DayStat[]` |
| `points.adjust` | `{ delta: number; reason: string }` | `PointEntry` | 手动调整，`kind='adjust'` |
| `points.preview` | `{ type: TaskType; difficulty: Difficulty }` | `number` | 纯计算，无副作用，UI 改难度/类型时实时显示；`type='daily'` 返回单日分值。**不传 `estimateMin`**——v0.7 起时长不进分值 |
| `points.streakPreview` | `{ current: number; nextDayWillReach: number }` | `number` | 明天完成能拿到的里程碑奖励，0 表示无。**`current` 无语义**（奖励只由 `nextDayWillReach` 决定，service 不读它），保留只为兼容既有调用形状，下一版契约删除 |
| `points.spend` | `{ amountCents: number; note?: string }` | `PointEntry` | **v0.45 新增**。记一笔零花钱支出，按当期汇率扣积分（公式见 §5.7）。`amountCents` 是**整数「分」**，不是元 |
| `points.spendUndo` | `{ entryId: string }` | `PointEntry` | **v0.45 新增**。撤销一笔支出，返回**反向那条** `adjust` 行（原行只打 `reversed_at`，不删） |
| `points.spendMonth` | —（`z.undefined()`） | `{ entries: PointEntry[]; totalCents: number; rate: number; weekStart: string }` | **v0.45 新增**。只看**当前月**，不传参——界面没有翻月需求。`totalCents` 只算未撤销的 `kind='spend'` 行 |

**v0.45 三条通道的口径（三处都不是随手定的）：**

- **单笔上限不放 guard**。guard 失败只能返回「请求参数格式不正确」，说不清是超了还是格式错；放 service 才能给出「单笔支出不能超过 1000 元」这句人话（04 §1.1）。guard 只管形状：`amountCents: z.number().int().positive()`、`note: z.string().max(40).optional()`、`entryId: z.string().min(1)`。
- **三个 handler 成功后都广播 `points.changed`**（`{ balance, entry, today }`，照 `task.complete` 那段）。撤销尤其要在广播**前**重算 `balance`——`rollback` 的反向行落在今天，用旧值广播会让 ③ 的大数字停在错的位置。
- **`spend` 不复用 `points.adjust`**：`adjust` 的 `kind`/`reasonCode` 写死成 `adjust`/`manual_adjust`，硬塞之后「手动调整」和「花钱」在明细里混成一类，账再也查不清。
- **周一的汇率评估不占通道**：`fxService.ensureWeek()` 由 `fxSweeper` 在后台调，只广播 `fx.changed`（§3.9），没有 `points.fxRefresh` 之类的手动入口（明确不做，05 W13）。


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

### 3.7b `api.hud`

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `hud.setMode` | `{ mode: 'ball' \| 'panel' }` | `void` | 切换形态：同一窗口换 bounds（不重建），球态 `resizable:false`、面板态 `resizable:true` |
| `hud.moveTo` | `{ x: number; y: number }` | `void` | 主进程 clamp 到该显示器 `workArea` 后落库；ball 态 `x` 由主进程强制回右边缘。拖动本身由主进程 `move` 事件去抖收尾，不依赖本通道 |
| `hud.dragBegin` | — | `{ x: number; y: number }` | v0.32：长条「长按拖动」起手，返回长条当前左上角（DIP）。渲染层据此算 `grabOffset`，之后只发绝对坐标 |
| `hud.dragTo` | `{ x: number; y: number; end: boolean }` | `void` | v0.32：把长条左上角移到绝对坐标 `x/y`（clamp 进工作区，整条不出屏）。`end:false` 只移窗、不落库、不判形态；`end:true` 落库并在**松手后**判一次形态（离左右边 > 工作区宽度 1/8 则展开成面板）。仅 `ball` 态有效，`panel` 态直接返回 |
| `hud.setVisible` | `{ visible: boolean }` | `void` | |
| `hud.getState` | — | `{ mode: HudMode; displayId: number; visible: boolean }` | v0.30 去掉 `expanded`。`visible` 取**「应显示」状态**而不是 `win.isVisible()` 的瞬时值（v0.20）：HUD 窗口的 `attach` 早于 `ready-to-show`，主窗顶栏可能在它出现前就取初态，取瞬时值会让开关显示关闭、HUD 随后自己浮现。窗口已销毁时返回 `false` |

v0.30 删除 `hud.setExpanded`：形态只有球/面板两态，由 `hud.setMode` 表达；`hud.expanded` 这个 settings key 一并从 `AppSettings` 删除，**旧库残留行不迁移**，只是再也读不到。

**已知缺口（v0.20 登记）**：`hud.setVisible` 没有回向事件（没有 `hud.visible.changed`），目前顶栏开关是唯一消费方、自己驱动自己。**W8B 设置页也要开关时必须先加这条事件**，否则两个入口会各存一份状态。`hud.visible` 也**不落 settings**：显隐是会话态，重启复位为显示——关掉以后忘了怎么找回，比"重启又出现"更糟。

### 3.8 `api.persona` / `api.memory`（v0.37 新增）

人物卡与长期记忆。两者都只有主进程能读写 DB，渲染层通过下面这些通道，**没有别的入口**。

| 方法 | 入参 | 返回 `T` | 说明 |
|---|---|---|---|
| `persona.get` | — | `Persona` | 返回当前 active 的一张。表空时就地建默认行（`id='default'`、`name='小助手'`、`userCall=''`、`personaMd=''`、`tone='warm'`）再返回，**不报错** |
| `persona.update` | `{ name?: string; userCall?: string; personaMd?: string; tone?: PersonaTone }` | `Persona` | 局部更新，只写传了的字段。校验：`name` 1~20 字（`INVALID_INPUT`「助手名字不能为空」/「助手名字最多 20 个字」）、`userCall` ≤ 20 字（「称呼最多 20 个字」）、`personaMd` ≤ 800 字（「人设最多 800 字」）。广播 `app.setting.changed`？**不广播**——Persona 不是 settings，跨窗口无人消费；改动下一轮聊天自然生效 |
| `memory.list` | `{ source?: MemorySource }` | `Memory[]` | `updatedAt` 降序。不传 = 全部 |
| `memory.add` | `{ contentMd: string; kind: MemoryKind }` | `Memory` | `source` 恒为 `'manual'`，**由主进程写死**，渲染层传了也忽略。`contentMd` 1~120 字（「记忆内容不能为空」/「记忆最多 120 个字」）；与已有条目重复时直接返回已有那条（`INSERT OR IGNORE` 语义），**不报错、不新增** |
| `memory.update` | `{ id: string; contentMd?: string; kind?: MemoryKind }` | `Memory` | 局部更新，`source` 不可改。改后的内容与另一条撞唯一索引 → `INVALID_INPUT`「这条记忆已经存在」 |
| `memory.remove` | `{ id: string }` | `void` | 硬删。查不到 → `NOT_FOUND`「记忆不存在」 |

三条硬规则：

- **`memory.add` 的 `source` 只能是 `manual`。** 自动提取走主进程内部函数（03 §4.4），**不经过 IPC**——否则渲染层可以伪造「模型提取的记忆」，来源字段就没有意义了。
- **记忆上限 50 条，只在自动提取路径上触发淘汰**（01 §2.9）。手动添加撞上限时返回 `INVALID_INPUT`「记忆已达 50 条，请先删几条」，**不淘汰用户手写的东西**。
- **没有任何「清空全部」通道。** 要清就逐条删；批量删除属于危险操作，界面上给一个按钮、误点一次就没了，不做。

### 3.9 `api.onEvent`（唯一事件入口）

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
  | { type: 'fx.changed'; rate: number; weekStart: string }   // v0.45：周一评估写库后发出
  | { type: 'reminder.fired'; reminderId: string; taskId: string | null; title: string; level: ReminderLevel }
  | { type: 'reminder.failed'; reminderId: string; channel: NotifyChannel; reason: string }
  | { type: 'daystats.changed'; day: DayStat }   // day 是**整个 DayStat 对象**，不是日期字符串——字段名易误读，渲染层直接整体覆盖对应日
  | { type: 'app.setting.changed'; key: string; value: unknown }
  | { type: 'channel.status'; channels: { id: NotifyChannel; available: boolean }[] }
  | { type: 'hud.mode.changed'; mode: HudMode }
  | { type: 'hud.visible.changed'; visible: boolean };

export type DomainEventType = DomainEvent['type'];
```

规则：

- **`hud.visible.changed`（v0.31 新增）**：`hud.setVisible` 生效后广播，载荷是**目标值**（不是
  `win.isVisible()` 的回读）。用途：HUD 自己从设置页关掉自己时，主窗顶栏开关必须同步——它不能只靠
  挂载时那次 `hud.getState()`，否则开关会停在旧视觉、要连点两次才生效。

- **`fx.changed`（v0.45 新增）**：`fxService.ensureWeek()` 写库成功后广播，用途是「开着的支出页自己刷新汇率」。**评估失败也广播**——失败同样落了一行 `source='fallback'`，对界面而言同样是"汇率变了"，不另造一个 `fx.failed`。不广播就只有一个后果：支出页把周一的旧汇率一直用到下次进页面（顶部那行和实际扣分对不上，用户会认为账算错了）。

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
  attachment: { add, get },                       // v0.35：get 与 add 一条一起注册
  ai:         { confirmDraft, rejectDrafts, review, health },
  points:     { balance, ledger, monthStats, adjust, preview, streakPreview },
  reminder:   { listByTask, listUpcoming, cancel, snooze, syncForTask, testChannel },
  channel:    { list, setConfig, setGlobal },
  hud:        { setMode, moveTo, dragBegin, dragTo, setVisible, getState },
  persona:    { get: getPersona, update: updatePersona },        // v0.37
  memory:     { list: listMemories, add: addMemory, update: updateMemory, remove: removeMemory }, // v0.37
  onEvent:    (cb: (e: DomainEvent) => void) => () => void,  // 返回取消订阅函数
});
```

`src/shared/types/ipc.ts` 里同步导出 `export interface Api`（上面这个对象的类型），preload 与渲染层都 `implements Api`，保证两侧不会各写各的。

**`setSetting` 是泛型方法**，`Api` 里的声明必须是：

```ts
setSetting<K extends keyof AppSettings>(
  input: { key: K; value: AppSettings[K] },
): Promise<IpcResult<void>>;
```

preload 侧写成箭头泛型即可（泛型只在编译期存在，运行时传的仍是 `{key, value}`，不影响 IPC 序列化）：

```ts
setSetting: <K extends keyof AppSettings>(input: { key: K; value: AppSettings[K] }) =>
  invoke<void>(CH.app.setSetting, input),
```

**不允许**为了省事把 `Api.setSetting` 退回 `{ key: string; value: unknown }`——那样设置页每个读写点都要手写断言，等于没做类型。

---

## 5. 积分公式契约（`src/shared/points/rubric.ts`）

**纯函数，主进程与渲染层共用同一份。所有数值来自 `settings['points.*']`，不是硬编码 —— 因为额度要商量，且以后可能调整。**

### 5.1 配置结构

```ts
export interface PointsConfig {
  difficultyBase: Record<Difficulty, number>;        // 活动 / 每日
  deadlineBase: Partial<Record<Difficulty, number>>; // v0.54：仅限时，缺档回落 difficultyBase
  dailyBase: number;                       // 每日任务单日基础分
  streakBonus: { days: number; bonus: number }[];  // 连续里程碑
  dailyCap: number | null;                 // 日上限，null=不限
}

export const DEFAULT_CONFIG: PointsConfig = {
  difficultyBase: { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
  deadlineBase: { easy: 2, medium: 3, hard: 5 },   // 限时只有这三档合法
  dailyBase: 1,
  streakBonus: [{ days: 7, bonus: 5 }, { days: 30, bonus: 10 }],
  dailyCap: null,
};
```

**`computePlannedPoints(type, difficulty, cfg)`（v0.54 起带类型参数）**：`deadline` 取 `cfg.deadlineBase[d]`，取不到回落 `cfg.difficultyBase[d]`；其余类型照旧取 `difficultyBase`。`RUBRIC_VERSION = 'v0.8'`。

**为什么分成两张表（v0.54，2026-11-01 用户拍板）**：用户原话「限时任务的基础分值太高了，应该设置为 2-5 分」。限时是日常作业/缴费，活动是考试/比赛，两者的"值多少钱"本来就不该同一把尺。**只降限时、活动与每日一分不动**，是用户明确裁决，不要为了"跨类型看起来一致"去动另外两类。

三条已知后果，**记录在案，实现方不许顺手调平**：

1. **限时逾期一天基本清零**：逾期扣分仍是 `2 分/天`，`easy 2−2→夹到 1`、`medium 3−2=1`、`hard 5−2=3`。用户看过这个后果后选了"扣分不动"。
2. **跨类型分值不可比**：限时 `hard 5` 低于活动 `medium 20`。
3. **积分更攒不动**：1 积分 = 1 元、额度基准 500，一个限时任务从 20 元变成 3 元。

### 5.2 限时 / 活动任务

```ts
/** 完成度系数：任务本身做到什么程度 */
export const QUALITY_FACTOR: Record<Quality, number> = {
  partial: 0.6, met: 1.0, exceeded: 1.15,
};

/** 限时任务的完成效率系数：距截止越早越高，封顶 1.2。leadHours 负数=逾期 */
export function efficiencyFactor(leadHours: number | null): number {
  if (leadHours === null) return 1;
  if (leadHours < 24) return 1;
  if (leadHours < 72) return 1.1;
  return 1.2;
}

/** 活动任务的结果系数：考试排名、比赛名次、作品评价 */
export function resultFactor(result: EventResult | null): number {
  if (result === 'exceeded') return 1.2;
  if (result === 'below') return 0.85;
  return 1;
}

/**
 * 统一精度：保留 2 位小数。
 * 不是为了"取整好看"，而是浮点乘除会累积误差（5.750000000000001），
 * 不收敛的话余额 SUM 几十次之后会出现 319.99999999999994 这种数。
 * 除这一个函数外，全项目任何地方都不许再对积分做 round / toFixed。
 */
export function roundPoints(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 应得分：由 type × 难度决定，v0.7 起与时长无关；v0.54 起限时走独立基数表 */
export function computePlannedPoints(
  type: TaskType,
  d: Difficulty,
  cfg = DEFAULT_CONFIG,
): number {
  const base = type === 'deadline' ? (cfg.deadlineBase[d] ?? cfg.difficultyBase[d]) : cfg.difficultyBase[d];
  return clamp(roundPoints(base), 1, 100);
}

export interface AwardInput {
  type: TaskType;
  planned: number;
  quality: Quality;          // event 不使用，由 result 表达
  overdueDays: number;       // 仅 deadline 扣分
  leadHours?: number | null; // 仅 deadline：(dueAt - completedAt) / 3600000
  result?: EventResult | null; // 仅 event
}

export function computeAwardedPoints(input: AwardInput): number {
  const { type, planned, quality, overdueDays } = input;
  const q = type === 'event' ? 1 : QUALITY_FACTOR[quality];
  const typeCoeff =
    type === 'deadline' ? efficiencyFactor(input.leadHours ?? null)
    : type === 'event'  ? resultFactor(input.result ?? null)
    : 1;
  const penalty = type === 'deadline' ? Math.min(overdueDays * 2, 20) : 0;
  return clamp(roundPoints(planned * q * typeCoeff - penalty), 1, roundPoints(planned * 1.4));
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), hi);
}
```

**`planned` 必须 ≥ 1，这是调用方的前置条件，不是本函数负责兜的。** `planned = 0` 时 `hi = roundPoints(0 * 1.4) = 0 < lo = 1`，`clamp` 退化成恒返回 0，而 `Math.max(v, 1)` 的结果会被 `Math.min(..., 0)` 吃掉——§5.6 承诺的"完成即正反馈、下限 1 分"当场失效。保证它 ≥1 是 `computePlannedPoints` 的职责（它自己 `clamp(..., 1, 100)`），**建任务时不许用 `pointsPlanned ?? 0` 兜底**，必须按 type 分派算出真值（见 §3.2 的 `task.createManual`）。

**积分一律是小数（2 位），全链路不做整数化。** 这一点会传导到数据库字段类型（01 §2 的 `REAL`）、`point_ledger.delta`、`daily_stats.points`、余额展示与日历热力分档，实现方不要在任何一层"顺手取整"。

**为什么时长不进公式（v0.7，2026-10-28 拍板）：** 旧版是 `难度基数 × 工作量系数`（0 min → 1.0，≥240 min → 1.6）。时长是用户或 AI 自己填的，等于"填得越长分越高"——磨洋工能刷分。现在时长只做两件事：给 AI 判定难度当输入、算提醒与逾期。分值只由难度决定。

应得分（B 档，**与时长无关**；v0.54 起限时改用独立基数表）：

| 难度 | trivial | easy | medium | hard | epic |
|---|---|---|---|---|---|
| **限时**（`deadlineBase`） | 不合法 | **2** | **3** | **5** | 不合法 |
| **活动**（`difficultyBase`） | 不合法 | 不合法 | 20 | 35 | 50 |
| **每日** | 1 | 1 | 1 | 不合法 | 不合法 |

每日恒取 `cfg.dailyBase`，不看难度，上表填 1 只为对照。

实得分举例，**限时以 medium 3 分为例**：

| 情形 | 算式 | 实得 |
|---|---|---|
| 提前 4 天完成，达标 | 3 × 1.0 × 1.2 | 3.6 |
| 提前 30 小时，达标 | 3 × 1.0 × 1.1 | 3.3 |
| 当天卡点完成 | 3 × 1.0 × 1.0 | 3 |
| 提前 4 天且超预期 | 3 × 1.15 × 1.2 | 4.14 |
| 逾期 1 天完成 | 3 − 2 | 1（下限兜底） |
| 逾期 3 天完成 | 3 − 6 → 夹到下限 | 1 |

**活动以 medium 20 分为例**（未变，照旧）：

| 情形 | 算式 | 实得 |
|---|---|---|
| 结果达标 | 20 × 1.0 | 20 |
| 结果超预期 | 20 × 1.2 | 24 |
| 结果不佳 | 20 × 0.85 | 17 |

上表每一行都应能被实现方徒手复算，复算不出来就是文档错了。

**注意限时那两行「逾期」——上限被 `planned × 1.4` 夹住、下限是 1，所以限时任务一旦逾期，`easy`/`medium` 基本就是 1 分。** 这是 v0.54「只降限时、扣分不动」的必然结果，已由用户确认，不要当成 bug 去"修正"。

**几个刻意的取舍：**

- **效率系数用绝对提前量，不用提前比例。** 用比例会让"截止日写得越远、立刻做完越赚"，等于把刚拆掉的时长口子从另一边开回来。三档、封顶 20%。
- **活动不看完成度，只看结果。** 考试你去了就是去了，分数才是有信息量的东西。两个系数叠乘会让"去考了但考砸"算出奇怪的数。
- **逾期扣分只对限时生效。** 活动的日期事前就固定，事后隔几天才确认不代表没做。
- **`leadHours = (dueAt − completedAt) / 3600000`，负数表示逾期。** 注意 `completedAt` 只能取"用户点确认 / 审核通过"的时刻，不是真正做完的时刻——晚点再点会拉低系数，这个偏差方向是对的（鼓励及时确认）。
- **`overdueDays` 按满 24 小时计一天，向下取整。** 逾期 23 小时算 0 天（不扣），逾期 47 小时算 1 天（扣 2 分）。用 `Math.floor(overdueHours / 24)`，取绝对值后再取整再乘。**这条是唯一允许在渲染层出现 `Math.floor` 的地方**（它不产出积分值，只产出一个天数），积分本身仍然只在 `computeAwardedPoints` 里算完。卡片上显示的「逾期 3 天」与扣分用的是同一个数，不许各算各的。
- **提前量的显示同理**：满 24 小时整才说「天」，否则说「小时」（`提前 30 小时`，不说 `提前 1.25 天`）。
- **取整的边界**：`roundPoints` 是对积分值取整的唯一入口。日期换算里的整除（月数、日数差）不属于积分，允许用 `Math.floor`/`Math.trunc`，但必须在注释里写明"不产出积分值"。除此之外任何 `Math.round`/`toFixed` 都要当成缺陷。

### 5.2b 难度档与任务类型的对应

难度不是五档随便选，按类型限定（2026-10-28 定稿，权威实现在 `src/shared/taskRules.ts`）：

| 类型 | 可选难度 |
|---|---|
| 每日 | `trivial` / `easy` / `medium` |
| 限时 | `easy` / `medium` / `hard` |
| 活动 | `medium` / `hard` / `epic` |

- **默认难度是 `medium`，不是 `easy`。** `medium` 三类都合法；`easy` 对 event 非法（04 §3.2 的下拉里根本没有这一项，`<select value="easy">` 匹配不到 option 会显示空白，任务却已经 2 分落了库）。01 §2.1 的 `DEFAULT 'easy'` 只是 SQL 兜底、不是应用层默认档，`createTask` 写 `input.difficulty ?? 'easy'` 是缺陷，不是"跟 DDL 对齐"。
- 切换类型时若当前难度不合法，用 `snapDifficulty(type, d)` 归位到最近合法档，**平手取低档**——切个类型就白涨几十分，用户会认为系统算错了。
- **校验落在三处**：AI 输出（W4 的 parse pipeline）、草稿归一化（渲染层 `normalizeDraft`）、主进程 `createTask`。前两处**归位**（`snapDifficulty`），保证卡面显示的就是合法档；主进程**不归位，直接 `INVALID_INPUT`**——它若悄悄换一个难度，卡面 35 分、库里 20 分，又变回两套口径。正常路径渲染层已经归过位，主进程报错只会发生在绕过 UI 的调用上。
- **草稿卡面分值与落库值必须同源**：`draftPointsOf(draft, cfg)` 的 `cfg` 必须是 `bootstrap.settings` 的 `points.*`（完整 `PointsConfig`），不许省略参数落回 `DEFAULT_CONFIG`，也不许只传 `dailyBase`。渲染层目前是 `dailyBase: number` 加一个写死的 `const DAILY_BASE = 1`，W2 的 bootstrap 接上后必须整条换掉：用户改过 `points.deadlineBase` 之后，卡面 +5 / 落库 +3 是同一类 bug 的另一种形态。
- **改难度必须同步应得分。** `TaskPatch` 含 `difficulty`，`updateTask` 收到 `difficulty` 时必须在**同一事务**里按本节规则重算 `points_planned`（daily 除外，它恒为 `cfg.dailyBase`），并做 type×difficulty 校验——难度从 `hard` 改成 `easy` 后 `points_planned` 若还是 5，完成时会按 5 发分。此条主进程已落地（v0.11 起，含历史脏值纠回测试）；渲染层的 `applyDraftPatch` 同样已实现。
- **daily 的 `points_planned` 只有一个来源：`cfg.dailyBase`。** `createTask` 收到 `{type:'daily', pointsPlanned: 99}` 时必须**忽略这个值**，不能原样落库——每日任务的应得分是定义出来的，不是调用方给的，`points_awarded` 也从不看它（走 `computeDailyPoints`）。`pointsPlanned < 1` 的入参校验照旧（显式给了就必须 ≥1），忽略只发生在"值合法但不用"。
- **数据库不设 CHECK**：条件约束以后要改就得写迁移，而历史数据不该因为规则收紧就读不出来。

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

> **v0.54 改动（2026-11-01 用户裁决）**：**只改了限时那一列**——限时 `easy/medium/hard` 从 10/20/35 降到 **2/3/5**，30 天里程碑从 +20 降到 **+10**。上表 B 档里活动（`medium/hard/epic` = 20/35/50）与每日（1 分）**一字未动**，所以"一个月典型总分 ≈ 320"对现在已不成立：10 次限时作业从 200 分变成 30 分。上表作为当初选档的历史记录保留，不要照它反推限时的当前值。

**为什么每日任务只给 1 分（已确认）**：每日任务是"低成本高频"，限时/活动是"高成本低频"。当初（v0.7）的理由是 1 分/天让 3 个习惯一个月贡献约 120 分，与 10 次作业的 200 分形成 3:5 的比例。

**v0.54 之后这个比例反过来了**：10 次限时作业只有约 30 分，3 个习惯仍是约 90 分 + 里程碑，习惯明显压过做事。**用户知道这一点并仍选择"只降限时"**——限时任务的分值要贴近"一次家务值几块钱"的直觉，而不是跟习惯打卡比高低。实现方不要为了"恢复 3:5"去动每日或连击，那是越界。

### 5.5 配置来源与生效

- 读 `settings['points.*']`，改配置后**只影响之后新算的分**，历史流水不回算。这是刻意的：积分一旦入账就是事实，回算会让历史账单天天变。
- `points.preview` 用当前配置实时算，所以草稿卡片上显示的分与最终入账一致。
- 日上限 `dailyCap` 若启用：当日累计达到上限后，后续入账按剩余额度截断，并在 `reason_text` 里写明"今日已封顶"。

### 5.6 设计意图（给实现方理解，不要写进 UI 文案）

- AI 只输出 `difficulty` 与 `estimateMin`，**不给分数**。分数由这里算，所以同一个任务无论在哪个窗口看、重算几次，结果一致。
- 上限 100 防止 epic 叠系数失控；下限 1 保证完成即正反馈。
- 历史流水不回算 —— 否则用户改一次配置，过去三个月的账单全部变动，信任直接崩。

### 5.7 零花钱：汇率与扣分（v0.45）

积分不只是分数，是**零花钱额度**。基准 1 积分 = 1 元，每周一由 AI 按上周表现小幅浮动。

**扣分公式（唯一一处换算，别在别的层再写一遍）：**

```
delta = -roundPoints(amountCents / 100 / rate)
```

- `rate` 的定义是「**1 积分值多少元**」，所以花掉的钱要**除以** `rate` 才是积分。
- `amountCents` 是整数「分」。`rate=1.08` 花 100.00 元 → `100 / 1.08 = 92.5925…` → **-92.59 分**（`roundPoints` 截两位，不四舍五入到 -92.6）。
- `rate=0.85` 花 100.00 元 → **-117.65 分**；`rate=1` 花 12.50 元 → **-12.5 分**。
- 算出 `delta === 0` 的金额一律**拒绝**（「金额太小，扣不进积分」），不写 0 分流水。
- **取整只准走 `roundPoints`**（`shared/points/rubric.ts`）。这条在 v0.45 之后措辞收紧成「**本文件不出现任何取整/定点格式化调用**」——`Math.round` / `toFixed` 全项目只准活在 `roundPoints` 内部。

**汇率区间与钳制（顺序不能换）：**

1. 非法值（`NaN` / `Infinity` / 负数）→ 当作评估失败，走 fallback；
2. `clamp(rate, 0.85, 1.15)`，再 `roundPoints` 到两位小数。

**没有「相对上期最多变动 X」这一层**：区间已经收在 `[0.85, 1.15]`，AI 可以在两期之间从 `0.85` 直接给到 `1.15`，不许再叠一道平滑。

**失败的降级是「沿用上期」，不是「回落 1.0」**：AI 未配置、上周无数据、输出不合法、超时——四种失败都写一行 `source='fallback'`，rate 取上期（无上期才 1.0）。回落 1.0 等于把攒下的升幅一次抹平，用户会认为"升值是假的"。写 fallback 行还顺带保证「每期只尝试一次」，`fxSweeper` 不会每 30 分钟烧一次 token。

**支出可以扣成负数**（用户裁决，不拦截）。余额为负时 ③ 的大数字变 `--danger`（04 §4③），扣分流程本身没有任何"余额不足"分支——有余额检查就不是零花钱了。

**改汇率永不重算历史**：每笔支出把当时的 `rate` 写进自己的 `fx_rate`（01 §2.4），历史是事实。

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
