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
```

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

  requires_evidence INTEGER NOT NULL DEFAULT 0,   -- ★ 1 = 完成时必须附证据才计分（S4 已定）
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
  kind          TEXT NOT NULL,              -- award|penalty|adjust
  reason_code   TEXT NOT NULL,              -- task_done|quality_bonus|overdue_penalty|manual_adjust|streak_bonus
  reason_text   TEXT NOT NULL DEFAULT '',
  day           TEXT NOT NULL,              -- 本地日历日 YYYY-MM-DD，供聚合
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_ledger_day  ON point_ledger(day);
CREATE INDEX idx_ledger_task ON point_ledger(task_id);

-- 限时/活动：一个任务只允许一条「完成发分」，从库层面杜绝重复发分
CREATE UNIQUE INDEX uq_ledger_task_done
  ON point_ledger(task_id)
  WHERE reason_code = 'task_done' AND occurrence_id IS NULL;

-- 每日任务：同一天的这一次只能发一次，不同天各自发
CREATE UNIQUE INDEX uq_ledger_occurrence
  ON point_ledger(occurrence_id)
  WHERE occurrence_id IS NOT NULL;
```

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
| `hud.mode` | `"dock-bar"` | `dock-bar` / `float-pod` |
| `hud.displayId` | `null` | 所在显示器 |
| `hud.position` | `{"x":null,"y":null}` | float-pod 的坐标 |
| `hud.autoHideFullscreen` | `true` | 全屏应用时隐藏 |
| `points.difficultyBase` | `{"trivial":5,"easy":10,"medium":20,"hard":35,"epic":50}` | ★ B 中档，已定 |
| `points.dailyBase` | `1` | ★ 每日任务单日基础分，已定 |
| `points.streakBonus` | `[{"days":7,"bonus":5},{"days":30,"bonus":20}]` | ★ 连续里程碑，已定 |
| `points.dailyCap` | `null` | 日上限，null=不限；S1 暂不做 |
| `reminder.quietHours` | `{"from":"22:00","to":"08:00"}` | 静默时段，落在其中顺延到 08:00 后 |
| `reminder.channels` | `["inapp","toast"]` | 全局默认渠道；配好邮箱后由用户勾上 `mail` |
| `channel.mail` | `{"to":""}` | ★ 收件邮箱。`to` 为空 = 未配置，渠道 `available()=false` 自动跳过，不报错 |
| `channel.webhook` | `null` | ★ 结构见 02 §3.0 的 `WebhookConfig`。`null` = 未启用；密钥不在此，走 `safeStorage` |
| `app.theme` | `"light"` | |

---

## 3. tasks 状态机（严丝合缝，实现方照做）

```
                    ┌──────────── 用户点丢弃 ──────────→ discarded
                    │
  (AI 产出草稿)      │
  会话卡片 ──确认──→ todo ──开始──→ doing ──提交完成──→ reviewing ──通过──→ done
                     ↑                │  ↑                  │              │
                     └──── 放弃 ──────┘  └──── 驳回 ─────────┘              │
                                                                           │
  done ──24h 内撤销──→ doing（同时写一条负流水冲销）                          │
  任意状态 ──归档──→ archived ←─────────────────────────────────────────────┘
```

约束：

- `draft` **不是** tasks 的状态。草稿只存在于 `messages.meta_json`。`tasks.status` 合法值 = `todo|doing|reviewing|done|discarded|archived`。
- **`deadline` / `event`**：进入 `done` 必须同时满足：`completed_at` 非空、`points_awarded` 非空、`point_ledger` 有对应 `task_done` 行（且 `occurrence_id IS NULL`）。三者同一事务写入。
- **`daily`**：任务本身**永不进入 `done`**，它一直在 `todo`/`doing`，直到 `active_to` 到期或用户手动归档。每天的状态体现在 `task_occurrences.status` 上。`tasks.points_awarded` 对 daily 恒为 NULL。
- **`event` 的自动流转**：`due_at` 过后 24 小时仍是 `todo`/`doing` 时，调度器把它推进到 `reviewing`，等用户确认结果（考试结束了，结果如何）。避免"考完就忘了点完成"，让积分烂尾。
- `discarded` 不计入任何统计，列表默认过滤。
- 有 `parent_id` 的子步骤，自身**不单独计分**，父任务完成时统一计分。
- **证据闸门（S4 已定）**：`requires_evidence = 1` 的任务，`reviewing → done` 必须满足 `evidence_json` 非空。缺证据时状态**停在 `reviewing`**，只能被驳回回 `doing` 或继续补证据，不能直接入账。这条在 `taskService.complete` 里硬校验，不靠 UI 拦。

---

## 4. 统计口径（避免各处算法打架）

| 指标 | 定义 | 来源 |
|---|---|---|
| 当前积分余额 | `SUM(point_ledger.delta)` | ledger |
| 今日积分 | `SUM(delta) WHERE day = 本地今日` | ledger |
| 今日完成数 | `COUNT(DISTINCT task_id) WHERE status='done' AND completed_at 为今日` + `COUNT(occurrences WHERE day=今日 AND status='done')` | tasks + occurrences |
| 今日待办数 | `COUNT(tasks WHERE type!='daily' AND status IN ('todo','doing'))` + `COUNT(occurrences WHERE day=今日 AND status='pending')` | 两表 |
| 当前任务 | 限时/活动：`status IN ('todo','doing','reviewing')`；每日：当日 `occurrence.status='pending'` | 两表合并 |
| **日历红点** | **只算 `deadline` / `event`**：`tasks(type IN ('deadline','event') AND date(due_at)=d AND status NOT IN ('discarded','archived'))`。**每日任务不参与红点**（Q2 已定） | 见 §4.1 |
| 连续天数 streak | `COUNT` 从今天（或昨天）向前连续 `occurrence.status='done'` 的天数 | occurrences |

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

- 文件：`src/main/db/migrations/001_init.sql`、`002_xxx.sql`，**只增不改**。
- `connection.ts` 启动时以 `PRAGMA user_version` 为**权威版本号**，顺序执行 `user_version` 之后的迁移文件，整体包在一个事务里。
- `schema_meta` **不参与版本判定**，只记迁移历史明细：`key = 'migration.001_init'`、`value = 应用时刻的 ISO 字符串`。版本号只认 `user_version`——它是整数、与 DDL 同事务原子提交，不会被业务代码误改；而 key/value 表要判断"已应用到第几号"得存数组再解析，多一层易错逻辑。两份记录不一致时以 `user_version` 为准。
- 迁移内禁止写业务数据（除 `settings` 默认值）。
- 破坏性变更（删列/改类型）必须走「建新表 → 拷数据 → 删旧表 → 改名」，且提供回滚脚本。
