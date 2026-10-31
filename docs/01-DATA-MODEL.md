# 01 · 数据模型

> 存储：本地 SQLite（`better-sqlite3`，WAL 模式），文件位于 `app.getPath('userData')/taskloop.db`
> 附件原文件位于 `app.getPath('userData')/attachments/YYYY/MM/<id>.<ext>`
> 只有主进程可访问。所有时间字段存 **ISO8601 UTC 字符串**（`2026-10-27T14:38:49.000Z`），只在展示层转本地时区。

---

## 1. 实体关系

```
tasks ──1:n── tasks(parent_id, 子步骤)
  │
  ├──1:n── task_occurrences   # 每日任务：每天一条；限时/活动：仅一条（日期=due_at）
  │              └──1:1── point_ledger(occurrence_id)
  ├──1:n── reminders
  ├──1:1── point_ledger(仅限时/活动的 task_done 行, 唯一索引)
  └──1:n── attachments(task_id, 可空)

messages ──1:n── attachments
messages ──n:1── tasks(linked_task_id, 可空)   # 草稿卡片/审核结果指向任务

daily_stats  # 物化聚合，可由 ledger + occurrences 全量重算
point_ledger # 积分唯一真相，余额 = SUM(delta)

personas    # 人物卡（v0.37）：助手是谁，v1 只有一行
memories    # 长期记忆（v0.37）：助手记住的「你是谁」，与 tasks 无关，也不挂在任何消息上
chat_state  # 会话摘要（v0.37）：单行，早于滚动窗口的历史压缩

fx_rates    # 零花钱汇率（v0.45）：一周一期，1 积分值多少元；与任何实体无外键
```

三张新表与既有实体**没有外键关系**：记忆不是任务的子集，人物卡也不属于某条消息。`memories` 故意不挂 `task_id`——「我每天早上七点起」这种事实来自对话，不来自任何一个任务。`fx_rates` 同理：汇率按**周**生灭，跟任务/消息都无关；支出流水只是把当时那一期的 `rate` 快照抄进自己的行（§2.4 的 `fx_rate`），不引用 `fx_rates.id`。

**为什么需要 `task_occurrences` 而不是让 tasks 一行记一次完成：**
每日任务是"长期坚持"，同一个任务要完成 30 次。如果沿用 `tasks.completed_at` 单字段，第 2 天完成后就把第 1 天的记录覆盖了，日历、连续天数、每日积分全部无从谈起。所以把"发生"抽成独立实体：一条 occurrence = 这个任务在这一天的这一次。

**余额不落地存储。** `balance = SELECT COALESCE(SUM(delta),0) FROM point_ledger`。任何"用户表里放一个 balance 字段"的方案都会在并发/回滚/撤销时和流水对不上。

---

## 2. 建表 DDL

> **关于 `★`**：下面 DDL 注释里的 `★` 是文档层的变更标记（表示"这条是某个版本新加的"），不是 SQL 内容。
> 写进 `migrations/001_init.sql` 时**删除 `★` 及其后空格**，其余逐字照抄。
> 理由：`02-CONTRACTS.md` §2 的类型定义要求与源码逐字一致，如果 DDL 里留着标记符号，两边标准就不统一了。

### 2.0 基础设施

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 2.1 tasks — 任务

```sql
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,               -- nanoid(12)
  type            TEXT NOT NULL DEFAULT 'deadline', -- ★ daily|deadline|event
  status          TEXT NOT NULL,                  -- 见 §3 状态机
  title           TEXT NOT NULL,                  -- ≤ 40 字，动词开头
  detail_md       TEXT NOT NULL DEFAULT '',       -- AI 补全后的可执行描述
  parent_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  sort_key        REAL NOT NULL DEFAULT 0,        -- 同级排序，插入取中值避免重排
  priority        INTEGER NOT NULL DEFAULT 0,     -- 0 普通 / 1 高 / 2 紧急
  difficulty      TEXT NOT NULL DEFAULT 'easy',   -- trivial|easy|medium|hard|epic
                                                  -- ★ DEFAULT 只是 DDL 兜底，**不是应用层默认档**：
                                                  -- 'easy' 对 event 非法（02 §5.2b），服务层必须显式传值
  estimate_min    INTEGER,                        -- 预估分钟。v0.9 起**不进积分公式**，只用于 AI 判难度、排提醒、算逾期

  -- ★ 时间语义按 type 解释，见 §2.1.1
  due_at          TEXT,                           -- deadline: 截止时刻 / event: 发生时刻 / daily: NULL
  daily_time      TEXT,                           -- daily: 'HH:mm'，每日提醒时刻
  repeat_rule     TEXT,                           -- daily: 'DAILY' | 'WEEKLY:1,3,5' | NULL=每天
  active_from     TEXT,                           -- daily: 起始日 YYYY-MM-DD
  active_to       TEXT,                           -- daily: 结束日，NULL=长期

  reminder_offsets_json TEXT NOT NULL DEFAULT '[]', -- ★ 分钟偏移，负数表示提前，见 §2.1.2
  reminder_channels_json TEXT NOT NULL DEFAULT '["inapp"]', -- ★ inapp|toast|mail|webhook

  tags_json       TEXT NOT NULL DEFAULT '[]',
  points_planned  REAL NOT NULL DEFAULT 0,        -- ★ 单次应得分（daily 为单日分值），2 位小数
  points_awarded  REAL,                           -- ★ 限时/活动：实际入账；daily 恒为 NULL（看 occurrences）
  quality         TEXT,                           -- partial|met|exceeded

  requires_evidence INTEGER NOT NULL DEFAULT 0,   -- ★ 历史字段：v0.38 起不参与任何判定（限时/活动一律要证据），保留不删以免迁移
  evidence_json   TEXT NOT NULL DEFAULT '[]',     -- ★ Evidence[]：文字说明或附件 id
  streak_current  INTEGER NOT NULL DEFAULT 0,     -- daily 专用：当前连续天数
  streak_best     INTEGER NOT NULL DEFAULT 0,     -- daily 专用：历史最佳
  source          TEXT NOT NULL DEFAULT 'chat',    -- chat|manual|hud
  ai_confidence   REAL,                           -- 0~1，低于 0.5 时 UI 提示需核
  ai_proposal_json TEXT,                          -- AI 原始提案，供追溯
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  archived_at     TEXT
);

CREATE INDEX idx_tasks_status_due ON tasks(status, due_at);
CREATE INDEX idx_tasks_type_status ON tasks(type, status);
CREATE INDEX idx_tasks_parent     ON tasks(parent_id);
CREATE INDEX idx_tasks_completed  ON tasks(completed_at);
CREATE INDEX idx_tasks_status_sort ON tasks(status, sort_key);
```

#### 2.1.1 三种任务类型

| type | 中文 | 对应场景 | `due_at` 含义 | 完成方式 | 计分 |
|---|---|---|---|---|---|
| `daily` | 每日任务 | 长期坚持（跑步、背单词、复盘） | 不使用（NULL） | 每天可完成一次，按 `task_occurrences` 记 | 按日计，见 §5 |
| `deadline` | 限时任务 | 作业、报告、缴费 | **截止时刻** | 只能完成一次 | 按 rubric 一次性 |
| `event` | 活动任务 | 考试、面试、会议 | **发生时刻** | 事件过后确认，只能完成一次 | 按 rubric 一次性 |

`deadline` 与 `event` 的区别不在数据结构，而在**提醒语义**：限时是"在你死线前催你"，活动是"帮你提前准备"。所以两者的默认 `reminder_offsets` 不同（§2.1.2）。

#### 2.1.2 提醒偏移策略（R13 / R14）

`reminder_offsets_json` 存相对 `due_at` 的分钟偏移数组，负数 = 提前。AI 建任务时按类型填默认值，用户可在任务详情里增删。

| type | 默认偏移 | 换算 |
|---|---|---|
| `deadline` | `[-1440, -60]` | 前 1 天、前 1 小时 |
| `event` | `[-10080, -4320, -1440]` | 前 7 天、前 3 天、前 1 天 |
| `daily` | （不使用偏移） | 按 `daily_time` 每天触发 |

具体触发时刻 = `due_at + offset`，但若落在深夜（默认 22:00-08:00）则顺延到当日/次日 09:00，避免半夜把人叫醒。这条规则在 `reminderService` 里实现，可关。

### 2.1.3 task_occurrences — 每日任务的发生记录

```sql
CREATE TABLE task_occurrences (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  day            TEXT NOT NULL,                -- YYYY-MM-DD 本地日
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|done|skipped|missed
  points_awarded REAL,                         -- ★ 2 位小数，单日实得
  completed_at   TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_occurrence_task_day ON task_occurrences(task_id, day);
CREATE INDEX idx_occurrence_day  ON task_occurrences(day);
CREATE INDEX idx_occurrence_done ON task_occurrences(day, status);
```

生成规则（`occurrenceService.ensureRange(fromDay, toDay)`，幂等）：

- 只为 `type='daily'` 且 `status IN ('todo','doing')` 的任务生成，且日期落在 `[active_from, active_to]` 内。
- **必须按 `repeat_rule` 过滤周几**：`NULL` 或 `'DAILY'` = 每天；`'WEEKLY:1,3,5'` = 仅这些 ISO 周几（1=周一 … 7=周日）。漏掉这条会把"每周三次"生成成 7 条，`streak` 与日历统计一并作废。
- 只生成 **今天及未来 3 个月**；过去日期的缺失视为"没做"，不回溯生成（避免历史被伪造）。
- 日历切月时调用一次，缺口补齐。单日单任务只生成一条（唯一索引兜底）。
- 错过未完成的 occurrence 在次日 00:05 由调度器批量置为 `missed`，并把 `streak_current` 归零。
- **occurrence 不做物理删除**，只改 `status`（`pending` / `done` / `skipped` / `missed`）。唯一会删它的是任务被物理删除时的 `ON DELETE CASCADE`，但那一刻 `point_ledger.task_id` 也同步变 `NULL`，而 `NULL` 在唯一索引里互不相等，`uq_ledger_task_done` 不会被误撞。将来若加入"删除某天记录"的入口，必须同时把关联流水的 `task_id` 置空，否则会撞索引。

### 2.1.4 point_ledger 的调整（应对每日任务重复发分）

`point_ledger` 增加 `occurrence_id` 列，并把原来的单条唯一索引拆成两条互斥的条件索引，完整 DDL 见 **§2.4**。

原来那条 `WHERE reason_code='task_done'` 的唯一索引会把每日任务第 2 天的发分直接拒掉，必须拆成按 `occurrence_id IS NULL` 互斥的两条。这是本期最容易踩的坑。

### 2.2 messages — 会话消息

```sql
CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL DEFAULT 'main',
  role           TEXT NOT NULL,                -- user|assistant|system
  kind           TEXT NOT NULL,                -- text|task_draft|task_review|reminder|error
  content_md     TEXT NOT NULL DEFAULT '',     -- 气泡正文（markdown）
  meta_json      TEXT NOT NULL DEFAULT '{}',   -- 卡片数据：草稿数组 / 审核结论 / 提醒载荷
  linked_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'sent', -- pending|streaming|sent|failed
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  latency_ms     INTEGER,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
```

`kind` 语义（渲染层按此选组件，不要自己加类型）：

| kind | role | meta_json 关键字段 |
|---|---|---|
| `text` | user / assistant | — |
| `task_draft` | assistant | `{ drafts: TaskDraft[] }`，见 02 §5 |
| `task_review` | assistant | `{ taskId, verdict }`——`verdict` 就是 02 §2 的 `ReviewVerdict` 对象（内含 verdict/quality/result/reason/followup/gaps），**不是扁平字段**。v0.8 起不要再在 meta 顶层写 `quality`/`awarded`/`reason` |
| `reminder` | system | `{ reminderId, taskId, title, fireAt, offsetMin }`——`offsetMin` 是写入侧从 `reminders.offset_min` 抄进来的**快照**，读取侧不现算（02 §2） |
| `error` | system | `{ code, message, retryable }` |

### 2.3 attachments — 附件

```sql
CREATE TABLE attachments (
  id         TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  task_id    TEXT REFERENCES tasks(id)    ON DELETE SET NULL,
  kind       TEXT NOT NULL,               -- image|file
  rel_path   TEXT NOT NULL,               -- 相对 userData/attachments/
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  sha256     TEXT NOT NULL,               -- 去重 + 完整性校验
  created_at TEXT NOT NULL
);

CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_sha     ON attachments(sha256);
```

### 2.4 point_ledger — 积分流水（唯一真相）

```sql
CREATE TABLE point_ledger (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  occurrence_id TEXT REFERENCES task_occurrences(id) ON DELETE SET NULL,
  delta         REAL NOT NULL,              -- ★ 正为得，负为扣；2 位小数，不做整数化
  kind          TEXT NOT NULL,              -- award|penalty|adjust|spend（★ v0.45 加 spend）
  reason_code   TEXT NOT NULL,              -- task_done|quality_bonus|overdue_penalty|manual_adjust|streak_bonus|pocket_spend
  reason_text   TEXT NOT NULL DEFAULT '',
  day           TEXT NOT NULL,              -- 本地日历日 YYYY-MM-DD，供聚合
  created_at    TEXT NOT NULL,
  reversed_at   TEXT,                       -- 被冲销的时刻；NULL = 这条发分仍然有效（002 迁移）
  amount_cents  INTEGER,                    -- ★ v0.45 支出金额（整数「分」）；只有 kind='spend' 有值
  fx_rate       REAL                        -- ★ v0.45 记账当时的汇率快照；只有 kind='spend' 有值
);

CREATE INDEX idx_ledger_day  ON point_ledger(day);
CREATE INDEX idx_ledger_task ON point_ledger(task_id);

-- 限时/活动：一个任务同时只允许一条「有效的完成发分」，从库层面杜绝重复发分
CREATE UNIQUE INDEX uq_ledger_task_done
  ON point_ledger(task_id)
  WHERE reason_code = 'task_done' AND occurrence_id IS NULL AND reversed_at IS NULL;

-- 每日任务：同一天的这一次同时只能有一条有效的发分，不同天各自发
CREATE UNIQUE INDEX uq_ledger_occurrence
  ON point_ledger(occurrence_id)
  WHERE occurrence_id IS NOT NULL AND reversed_at IS NULL;
```

**撤销 = 标记 + 负流水，两步缺一不可。** 撤销时把原发分行打上 `reversed_at`（不改金额、不删行，审计仍查得出哪条被冲了、什么时候冲的），同时写一条等额负流水（`kind='adjust'`、`reason_code='manual_adjust'`、`occurrence_id=NULL`），余额仍是 `SUM(delta)`。

两条唯一索引的谓词都带 `reversed_at IS NULL` 是**必须的**：它们约束的是"同时最多一条有效发分行"，不是"历史上只许出现一条"。少了这个谓词，撤销后重做必然撞索引——限时任务报「这个任务已经发过完成分了」，每日任务报「这一天的打卡已经发过分了」（误点一次撤销，当天再也打不上卡）。冲销只允许一次：对已 `reversed_at` 的行再冲会多写一条负流水、把余额扣两次，所以 `markReversed` 在 `changes === 0` 时按内部故障 `DB_ERROR` 抛出（04 §1.2）。

**同一天里"旧的已冲销行 + 新的有效行"会共存**，任何按任务/按天收集流水的逻辑（如 `entriesOfOccurrence`）都必须筛 `reversed_at IS NULL`，否则会把同一条历史发分重复冲销。

**`amount_cents` / `fx_rate`（v0.45，迁移 004）两列都可空，且只对 `kind='spend'` 有值。** 其余行（发分、惩罚、冲销）一律 `NULL`，**不许给它们塞 0**——"0 分的支出"和"这不是支出"是两件事，塞 0 之后「本月已花」的求和与行数统计都会错。

- `amount_cents` 是**整数「分」**，不是元。浮点元进库必然出现 `1250.0000000000002`，余额和「已花 / 500」再也对不平。解析与换算在渲染层/服务层完成（04 §1.4、02 §5.7），库里只存整数。
- `fx_rate` 是**记账那一刻的快照**（1 积分值多少元）。汇率每周一会变，但**改汇率永不重算历史**：历史是事实，重算会让上个月的账今天变样。
- **不给这两列加 CHECK 约束、不改既有索引**：`point_ledger` 上现在没有任何约束，加约束会让旧库迁移失败（004 只 `ALTER TABLE ... ADD COLUMN`，不带 `DEFAULT`）。

### 2.5 reminders — 提醒

```sql
CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  occurrence_id TEXT REFERENCES task_occurrences(id) ON DELETE CASCADE,  -- 每日任务指向当天
  offset_min    INTEGER,                       -- 相对 due_at 的偏移；NULL = 绝对时间
  fire_at       TEXT NOT NULL,
  repeat_rule   TEXT,                          -- NULL=一次性；'DAILY'|'WEEKLY:1,3,5'
  channels_json TEXT NOT NULL DEFAULT '["inapp"]', -- inapp|toast|mail|webhook
  level         TEXT NOT NULL DEFAULT 'normal',    -- normal|strong，见 04 §9
  status        TEXT NOT NULL DEFAULT 'active',-- active|fired|paused|cancelled|failed
  last_fired_at TEXT,
  fired_channels_json TEXT NOT NULL DEFAULT '[]',  -- 已成功送达的渠道，便于补发不重复
  fail_reason   TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_reminders_fire ON reminders(status, fire_at);
CREATE UNIQUE INDEX uq_reminder_task_offset
  ON reminders(task_id, offset_min)
  WHERE offset_min IS NOT NULL AND status IN ('active', 'paused');
```

**条件里为什么不含 `fired` 与 `failed`**：已触发/已失败的行是**历史**，不参与"当前该有哪几条提醒"的判定。若把它们也算进唯一性，同一偏移触发过一次之后再 `syncForTask`（比如改了 `due_at` 导致 `fire_at` 变化）就会插不进去——这是 W8 必踩的坑。正确行为是：旧行留作历史，新建一条 `active` 行。

**同步策略**：`reminders` 是**从** `tasks.reminder_offsets_json` 生成的物化结果，不是独立真相。任务新建或时间变更时调 `reminderService.syncForTask(taskId)`：删除未触发的旧行（`active` / `paused` / `failed`）→ 按偏移重建。唯一索引只约束"当前有效"的那几条，保证重复 sync 不会产生重复提醒。

### 2.6 daily_stats — 日历聚合（可重建）

```sql
CREATE TABLE daily_stats (
  day             TEXT PRIMARY KEY,   -- YYYY-MM-DD
  points          REAL NOT NULL DEFAULT 0,     -- ★ 2 位小数，不做整数化
  tasks_done      INTEGER NOT NULL DEFAULT 0,  -- tasks 表当日 done 数；每日任务另有 occurrences_done，不要加进来
  tasks_created   INTEGER NOT NULL DEFAULT 0,
  occurrences_done INTEGER NOT NULL DEFAULT 0  -- ★ 每日任务完成数
);
```

写入规则：只在 `pointsService` / `taskService` / `occurrenceService` 的同一事务内 upsert。提供 `rebuildDailyStats()` 用于兜底重算（`npm run db:rebuild-stats`）。

### 2.7 settings — 配置

```sql
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

已知 key（实现方不得自造 key）：

| key | 默认值 | 说明 |
|---|---|---|
| `ai.provider` | `{"name":"zhipu","model":"glm-5.3-flash"}` | 接入前需真机验证该模型支持图片。**本版 `name` 只接受 `zhipu`**，`harness` 虽在契约里保留但未实现 |
| `ai.apiKey` | `""` | 存 keytar / 安全存储，**不存明文 DB，也不在 `AppSettings` 里**（因此它永远不出现在 IPC 上） |
| `hud.mode` | `"ball"` | `ball` / `panel`（v0.30；旧值 `dock-bar`/`float-pod` 一律按 `ball` 起） |
| `hud.displayId` | `null` | 所在显示器 |
| `hud.position` | `{"x":null,"y":null}` | 位置：ball 只存 y（x 锁右边缘），panel 存 x/y |
| `hud.size` | `null` | v0.30 新增：panel 拉伸后的尺寸，null = 默认 360×480 |
| `hud.background` | `null` | v0.30 新增：背景色，null = 跟随主题 |
| `hud.opacity` | `1` | v0.30 新增：背景透明度 0.3–1 |
| `hud.autoHideFullscreen` | `true` | 全屏应用时隐藏。**v0.17：本轮不实现检测**（无原生依赖时不可靠，W10 真机评估），key 保留 |
| `points.difficultyBase` | `{"trivial":5,"easy":10,"medium":20,"hard":35,"epic":50}` | ★ B 中档，已定 |
| `points.dailyBase` | `1` | ★ 每日任务单日基础分，已定 |
| `points.streakBonus` | `[{"days":7,"bonus":5},{"days":30,"bonus":20}]` | ★ 连续里程碑，已定 |
| `points.dailyCap` | `null` | 日上限，null=不限；S1 暂不做 |
| `reminder.quietHours` | `{"from":"22:00","to":"08:00"}` | 静默时段，落在其中顺延到 08:00 后 |
| `reminder.channels` | `["inapp","toast"]` | 全局默认渠道；配好邮箱后由用户勾上 `mail` |
| `channel.mail` | `{"to":""}` | ★ 收件邮箱。`to` 为空 = 未配置，渠道 `available()=false` 自动跳过，不报错 |
| `channel.webhook` | `null` | ★ 结构见 02 §3.0 的 `WebhookConfig`。`null` = 未启用；密钥不在此，走 `safeStorage` |
| `app.theme` | `"light"` | |
| `ai.chat.model` | `"glm-4.7-flashx"` | **v0.37 新增**（第 18 个 key）：闲聊专用模型，纯文本、非推理、走 `/chat/completions` 但**不带图片**。任务侧仍用 `ai.provider.model`（`glm-5.3-flash`，要推理与识图）。两个模型名分开存，是因为 `ai.provider` 是对象、`settingRepo.getAll()` 做浅合并，往里塞字段会被整对象覆盖掉 |

> **v0.37 为什么是两个 key 而不是一个对象**：`settings` 表只存用户真正改过的 key，读取时用 `DEFAULT_SETTINGS` 做底再**浅合并**。用户一旦改过 `ai.provider`（哪怕只改 model），库里那一行就是完整对象，任何新增子字段都会被覆盖成 `undefined`。所以聊天模型必须是顶层 key。

---

### 2.8 personas — 人物卡

```sql
CREATE TABLE personas (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,                 -- 助手名字，1~20 字
  user_call  TEXT NOT NULL DEFAULT '',      -- 怎么称呼用户，空串 = 用「你」
  persona_md TEXT NOT NULL DEFAULT '',      -- 人设正文，≤ 800 字
  tone       TEXT NOT NULL DEFAULT 'warm',  -- warm|plain|playful
  is_active  INTEGER NOT NULL DEFAULT 1,    -- 0/1
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_personas_active ON personas(is_active) WHERE is_active = 1;
```

- **表支持多张，v1 只用一张。** 唯一部分索引保证「同时最多一张 active」，`persona.setActive` 在同一事务里先把别的置 0 再置 1。
- **行不预置。** 迁移里不插数据（§5 的规矩），`persona.get` 发现表空时就地建一行 `id='default'`、`name='小助手'`、其余为空，然后返回它。首次打开聊天不会因为「没配人设」而报错。
- `tone` 只影响 prompt 里的一句语气指令（03 §4.3），不参与任何业务判断，非法值按 `warm` 处理。
- `persona_md` 是**用户自己写的话**，原样进 system prompt 的 `{PERSONA}` 位置，程序不解释、不解析、不加前缀。

### 2.9 memories — 长期记忆

```sql
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,
  content_md TEXT NOT NULL,                 -- 一条一句话，≤ 120 字
  kind       TEXT NOT NULL,                 -- profile|preference|fact
  source     TEXT NOT NULL,                 -- auto|manual
  hits       INTEGER NOT NULL DEFAULT 0,    -- 被带进 system prompt 的次数
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_memories_content ON memories(content_md);
CREATE INDEX idx_memories_updated ON memories(updated_at DESC);
```

| `kind` | 装什么 | 例子 |
|---|---|---|
| `profile` | 我是谁、我的处境与目标 | `在读研二，方向是分布式系统` |
| `preference` | 我喜欢 / 不喜欢什么、怎么跟我说话 | `不喜欢被追问细节，喜欢直接给结论` |
| `fact` | 可核对的事实性信息 | `养了一只猫叫豆豆` |

- **`content_md` 唯一**：重复提取同一条是常态（模型每轮都会看到同样的信息），唯一索引让「提取到已存在的记忆」变成 `INSERT OR IGNORE` 的 no-op，不需要先查后写。
- **上限 50 条。** 写入前若已满，先淘汰一条：`hits` 升序 → `updated_at` 升序（最没用 + 最久没碰的先走）。淘汰是硬删，不做软删、不做归档。
- **`hits` 是淘汰依据，不是展示字段。** 每次 `chat` 把一条记忆拼进 system 就给它的 `hits + 1`（一条 SQL，`UPDATE ... WHERE id IN (...)`）。
- 记忆**没有过期时间**：用户手动删才没。`auto` 提取的条目和 `manual` 的条目在存储上完全平等，只有 `source` 一个字段区分来源，供设置页显示与「一键清空自动记忆」。

### 2.10 chat_state — 会话摘要

```sql
CREATE TABLE chat_state (
  id              TEXT PRIMARY KEY,              -- 恒为 'main'
  summary_md      TEXT NOT NULL DEFAULT '',      -- 滚动窗口之前的历史摘要，≤ 600 字
  upto_message_id TEXT,                          -- 摘要已覆盖到哪一条（含）；NULL = 还没摘要过
  updated_at      TEXT NOT NULL
);
```

- **单行表**，`id` 恒 `'main'`。会话只有一个 thread，多行没有意义。
- **什么时候写**：`msg.list` 或 `msg.send` 取上下文时，若「`upto_message_id` 之后的原文条数 > 40」才触发一次摘要压缩——把「旧摘要 + 这 40 条里的前 20 条」交给模型压成新的 `summary_md`，`upto_message_id` 前移到第 20 条。**压缩在后台跑，不阻塞这一轮回复**；失败就保留旧摘要、下轮再试，不报错给用户。
- 摘要只覆盖**对话内容**，不涵盖任务数据。任务摘要每轮由主进程现取现拼（03 §4.3），因为任务的「今天」天天在变，静态摘要第二天就是错的。

### 2.11 fx_rates — 零花钱汇率（v0.45，迁移 004）

```sql
CREATE TABLE fx_rates (
  id         TEXT PRIMARY KEY,
  week_start TEXT NOT NULL UNIQUE,      -- 该汇率生效的周一（本地日 YYYY-MM-DD）
  rate       REAL NOT NULL,             -- 1 积分值多少元
  basis      TEXT NOT NULL DEFAULT '',  -- AI 的评估依据，只进库、不上界面
  source     TEXT NOT NULL,             -- ai | fallback
  created_at TEXT NOT NULL
);
```

- **一周一期，`week_start` 唯一**：重复插入由库挡住（`fxService.ensureWeek` 因此天然幂等——本周已有记录就直接返回，什么都不做）。
- **`rate` 合法区间 `[0.85, 1.15]`，两位小数，基准 1.0（1 积分 = 1 元）**。区间钳制与取整在写入前完成（02 §5.7、03 §4.5），库层不设 CHECK——与 `point_ledger` 同一口径，不给旧库添约束。
- **`source='fallback'` 的行也是有效汇率**：AI 未配置、上周无数据、或评估失败时，沿用**上期** rate 写一行（无上期才用 1.0）。**失败不许回落 1.0**，那等于把攒下的升幅一次抹平。写 fallback 行还顺带保证「每期只尝试一次」，sweeper 不会每 30 分钟烧一次 token。
- **`basis` 只进库**：它是模型的评估理由，用于排查「这周为什么升值/贬值」，不进 `FxRate` 类型、不进渲染层（02 §2.2）。
- **`week_start` 是本地日**，不是 ISO 周号。取值走 `weekStartOf(day)`（`addDays(day, -(isoWeekday(day) - 1))`），与 `01 §2.6` 的 `daily_stats.day` 同一套本地日口径。
- **历史汇率不删不改**：`currentRate()` 取「本周那一条；没有就取最近一条；一条都没有按 1.0」，永远不抛错——记账不该因为汇率表是空的而失败。


---

## 3. tasks 状态机（严丝合缝，实现方照做）

```
                    ┌──────────── 用户点丢弃 ──────────→ discarded
                    │
  (AI 产出草稿)      │
  会话卡片 ──确认──→ todo ──开始──→ doing
                     │  ↑             │  ↑
                     │  └──── 放弃 ───┘  └──── 取消／超时 10 分钟 ────────┐
                     │                                                    │
                     └────── 提交完成 ──┐        ┌── 提交完成 ──────────────┤
                                        ↓        ↓                          │
                                  pending_review（v0.38 新增：待提交）        │
                                        │                                   │
                                        └──提交审核──→ reviewing ──通过──→ done
                                                          │                 │
                                                          └──驳回──→ doing ──┘
  reviewing ──驳回且已过 due_at──→ missed（v0.34：判失败，不计分）
  done ──24h 内撤销──→ doing（同时写一条负流水冲销）
  任意状态 ──归档──→ archived
```

约束：

- **`todo → reviewing` 是合法边（v0.25）**：界面没有「开始」按钮，新建任务默认就是 `todo`，不允许这条边等于「新建的限时/活动任务永远完不成」。这条边**不改 `started_at`**（没开始过就是没开始过），`task.complete` 仍要求前置状态为 `reviewing`。调度器（W8）判定 `event` 超期时走的也是这条边。
- `draft` **不是** tasks 的状态。草稿只存在于 `messages.meta_json`。`tasks.status` 合法值 = `todo|doing|pending_review|reviewing|done|missed|discarded|archived`。
- **`pending_review`（v0.38 新增：待提交）**：用户点了完成、但还没提交审核的暂存态。
  - 入口只有两条：`todo → pending_review`、`doing → pending_review`（点完成 / 确认条上的完成）。
  - 出口三条：`→ reviewing`（卡片上点「提交」，且必须已有至少 1 条证据）、`→ doing`（点「取消」，或**停留超过 10 分钟**被主进程自动退回）、`→ discarded / archived`。
  - **没有任何计时意义上的"审核中"**：任务停在这里时 AI 一次都没被调用、也不会自动送审。这条状态存在的唯一理由，是让"等着用户交材料"和"AI 正在看材料"在状态机里可区分——否则「10 分钟超时退回」会把正在等 AI 回复的任务一起打回去。
  - `pending_review → reviewing → done` 时 `started_at` 与 `completed_at` 的写入规则不变（`started_at` 只在第一次进 `doing` 时写）。
- **`deadline` / `event`**：进入 `done` 必须同时满足：`completed_at` 非空、`points_awarded` 非空、`point_ledger` 有对应 `task_done` 行（且 `occurrence_id IS NULL`）。三者同一事务写入。
- **`daily`**：任务本身**永不进入 `done`**，它一直在 `todo`/`doing`，直到 `active_to` 到期或用户手动归档。每天的状态体现在 `task_occurrences.status` 上。`tasks.points_awarded` 对 daily 恒为 NULL。**`daily` 也不接受 `pending_review` / `reviewing`**（每日任务不接审核）。
- **`event` 的自动流转**：`due_at` 过后 24 小时仍是 `todo`/`doing` 时，调度器把它推进到 `reviewing`，等用户确认结果（考试结束了，结果如何）。避免"考完就忘了点完成"，让积分烂尾。
- `discarded` 不计入任何统计，列表默认过滤。
- 有 `parent_id` 的子步骤，自身**不单独计分**，父任务完成时统一计分。
- **证据闸门（v0.38 改）**：**`deadline` / `event` 一律要求证据**，不再看 `requires_evidence` 字段。
  - `reviewing → done` 必须满足 `evidence_json` 非空；缺证据时状态停在 `reviewing`，只能被驳回回 `doing` 或继续补证据，不能直接入账。这条在 `taskService.complete` 里硬校验，不靠 UI 拦。
  - AI 侧同样硬拦：`reviewPipeline.hardGateOf` 只在证据数 > 0 时才允许调模型，否则直接判 `need_evidence`。**只凭用户一句"我做完了"不可能拿到 `pass`** —— 这正是 v0.37 之前的行为（`requires_evidence` 手动建任务时恒为 false，导致所有限时任务被当"不需要证据"秒过）。
  - `requires_evidence` 列**保留不删**（避免迁移），但自 v0.38 起**不参与任何判定**，仅作历史数据。`task.setRequiresEvidence` 通道同步失效（保留注册，调用不再改变审核行为）。
- **`missed` 是终点状态（v0.34）**：`reviewing → missed` 是唯一入口，且只在「AI 审核驳回（`partial` 或 `fail`）**且** `due_at` 已过」时进入；只有 `archived` 一条出口。`missed` 不计分、不写流水、不计入完成率。`due_at` 为 null 的任务驳回后一律回 `doing`，不判 `missed`——不做定时扫描，超期判失败只发生在审核驳回这一刻。

---

## 4. 统计口径（避免各处算法打架）

| 指标 | 定义 | 来源 |
|---|---|---|
| 当前积分余额 | `SUM(point_ledger.delta)` | ledger |
| 今日积分 | `SUM(delta) WHERE day = 本地今日` | ledger |
| 今日完成数 | `COUNT(DISTINCT task_id) WHERE status='done' AND completed_at 为今日` + `COUNT(occurrences WHERE day=今日 AND status='done')` | tasks + occurrences |
| 今日待办数 | `COUNT(tasks WHERE type!='daily' AND status IN ('todo','doing','pending_review'))` + `COUNT(occurrences WHERE day=今日 AND status='pending')` | 两表 |
| 当前任务 | 限时/活动：`status IN ('todo','doing','pending_review','reviewing')`；每日：当日 `occurrence.status='pending'` | 两表合并 |
| **日历红点** | **只算 `deadline` / `event`**：`tasks(type IN ('deadline','event') AND date(due_at)=d AND status NOT IN ('discarded','archived'))`。**每日任务不参与红点**（Q2 已定） | 见 §4.1 |
| 连续天数 streak | `COUNT` 从今天（或昨天）向前连续 `occurrence.status='done'` 的天数 | occurrences |
| **本月已花**（v0.45） | `SUM(amount_cents) WHERE kind='spend' AND reversed_at IS NULL AND day BETWEEN 月初 AND 月末` | ledger |

**「本月已花」只对 `kind='spend'` 求和，且必须筛 `reversed_at IS NULL`**：冲销后原行还在库里（只打了时间戳），不筛就会把已撤销的支出继续算进预算。单位是「分」，与 `MONTHLY_BUDGET_CENTS = 50000` 同单位比较，**不要换成元再比**。

**支出行的 `delta` 与 `amount_cents` 是两件事**：`delta` 是扣掉的积分（`-roundPoints(amountCents / 100 / rate)`），`amount_cents` 是花掉的元。余额取 `SUM(delta)`，预算取 `SUM(amount_cents)`——拿 `SUM(delta)` 当金额用，汇率一浮就差出 15%。


**积分是小数（2 位），不是整数。** 余额、今日积分、`daily_stats.points` 全部按 `REAL` 存、按小数算，展示层用 `fmtPoints()` 格式化（04 §4③）。任何一层做 `Math.round` / `INTEGER` 转换都会让余额与流水对不上，属于 P0 缺陷。

### 4.1 日历查询的唯一实现（`calendarService.dayIndex`）

日历一个月的红点**不要**在渲染层逐个日期轮询。主进程给一次查询：

```sql
-- 输入 :from, :to （YYYY-MM-DD 本地日）
SELECT date(due_at, 'localtime') AS day,
       COUNT(*)                                        AS total,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count
FROM tasks
WHERE type IN ('deadline','event')
  AND due_at IS NOT NULL
  AND date(due_at, 'localtime') BETWEEN :from AND :to
  AND status NOT IN ('discarded','archived')
GROUP BY day;
```

点某日 → `calendarService.dayDetail(day)` 返回该日 `deadline` / `event` 任务条目（含 type、title、本地时刻、状态、分值），供 04 §4② 展开列表使用。**不要**把 daily occurrence 混进来——那是 ① 区和会话的事，日历只负责"有确定日期的任务"。

**时区陷阱**：`day` 字段在写入时按**本地时区**计算后存字符串，不要用 SQLite 的 `date()` 直接处理 UTC 字段，否则东八区用户 08:00 前的记录会串到前一天。SQL 里的 `date(due_at,'localtime')` 是必须显式带 `'localtime'` 的例外，且**没有索引可用**——若某天数据量变大，再加一个 `due_day` 生成列并建索引。

---

## 5. 迁移规范

- 文件：`src/main/db/migrations/001_init.sql`、`002_xxx.sql`，**只增不改**。当前清单（`migrations/index.ts` 的数组，顺序只增不改）：`001_init`、`002_ledger_reversed`、`003_chat`、`004_spend`（v0.45，`user_version = 4`）。
- `connection.ts` 启动时以 `PRAGMA user_version` 为**权威版本号**，顺序执行 `user_version` 之后的迁移文件，整体包在一个事务里。
- `schema_meta` **不参与版本判定**，只记迁移历史明细：`key = 'migration.001_init'`、`value = 应用时刻的 ISO 字符串`。版本号只认 `user_version`——它是整数、与 DDL 同事务原子提交，不会被业务代码误改；而 key/value 表要判断"已应用到第几号"得存数组再解析，多一层易错逻辑。两份记录不一致时以 `user_version` 为准。
- 迁移内禁止写业务数据（除 `settings` 默认值）。
- 破坏性变更（删列/改类型）必须走「建新表 → 拷数据 → 删旧表 → 改名」，且提供回滚脚本。
