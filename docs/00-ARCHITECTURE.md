# 00 · 架构总纲

> 项目代号：`taskloop`
> 文档状态：v0.1 架构基线（接口冻结前）
> 技术基线：Electron + React 18 + TypeScript(strict) / 智谱 GLM / 本地 SQLite / 双窗口
> 本文档是**唯一权威**。任何实现与本文冲突，以实现方提出的「变更单」走流程修改本文，不得私自改代码绕过。

---

## 1. 需求溯源表

下表中的「来源」决定了这条设计的可推翻性：`用户明确` 的部分**实现方不得改动**；`实现选择` 是我为了把需求落地做的技术判断，可以按证据改写；`待确认` 的部分**不得先行实现**。

| # | 需求 | 设计落点 | 来源 |
|---|---|---|---|
| R1 | 发一段话或一张图，AI 识别内容 | 多模态输入 → `ai.parse` → 意图路由（见 03） | 用户明确 |
| R2 | AI 自动补充细节 | 输出 `detail_md` + `steps[]` + `missing_info[]`，信息不足**追问而非编造** | 用户明确 |
| R3 | 给予适当的完成积分奖励 | 分值由**代码公式**计算，AI 只做难度分类（见 03 §4） | 实现选择 |
| R4 | 最后形成任务 | 草稿态 `draft` → 用户确认 → `todo`，审核闸门必须先过 | 用户明确 |
| R5 | AI 会话用于创建和审核任务 | 单一会话流 + 4 类意图（create / review / query / chat） | 用户明确 |
| R6 | 兼具提醒功能 | `reminders` 表 + 调度器 + **提醒消息写回会话流** | 用户明确 |
| R7 | 小会话窗口，右侧当前任务 / 日历 / 积分 / 明细 | 主窗两栏布局，右栏四区块堆叠 | 用户明确 |
| R8 | 任务栏以悬浮方式显示在屏幕上方 | 独立 HUD 窗口，`dock-bar` 与 `float-pod` 双模式 | 用户明确（形态可切换为已确认选择） |
| R9 | 想法活络但用户要求排首位 | 所有偏离需求的设计必须加 `[建议]` 标记并单列到 §7 | 用户明确 |
| R10 | 日历上有任务的日子下方显示红点 | `task_occurrences` 按日聚合，红点 = 该日有任务 | 用户明确 |
| R11 | 点日期能展开看到相关任务 | 日历点击 → 就地展开该日任务列表，不跳页 | 用户明确 |
| R12 | 任务分三类：每日 / 限时 / 活动 | `tasks.type`，分别对应长期坚持 / 作业 / 考试 | 用户明确 |
| R13 | 限时任务：前 1 天、前 1 小时提醒 | `reminder_offsets = [-1440, -60]` | 用户明确 |
| R14 | 活动任务：前 7 天、前 3 天、前 1 天提醒 | `reminder_offsets = [-10080, -4320, -1440]` | 用户明确 |
| R15 | 提醒要醒目，不局限于应用内，考虑外部推送到 QQ | 多渠道通知：应用内 / 系统通知 / 外部桥接（可插拔） | 用户明确（渠道实现待定） |
| R16 | 积分额度可以商量，不要一下定死 | 分值表落 `settings`，可调；先给三档预设讨论 | 用户明确 |

---

## 2. 三条不可违反的架构不变量

这三条是整套设计的地基。实现方如果为了图快破例，后面每一处都会出问题。

**I1 — 主进程是唯一写入者。**
渲染进程（主窗、悬浮窗）**不允许**直接访问 SQLite、文件系统、网络。所有读写走 IPC 到主进程 `services/`。原因：双窗口共享同一份数据，两处都能写必然产生分叉与竞态。

**I2 — 一次写 = 一个事务 + 一条领域事件。**
每个写操作在 `services/` 内完成「改库 → 计算派生值 → 广播 `DomainEvent`」。渲染进程**只有一个**数据更新入口：订阅 `bus:event`。任何窗口不做轮询、不做本地乐观写库。原因：主窗勾掉一个任务，悬浮条必须立刻同步，靠事件而不是靠定时刷新。

**I3 — AI 只产出「提案」，永不直接落库。**
AI 的输出一律是 `TaskDraft`，先存成会话消息（`messages.kind='task_draft'`），等用户在会话里点确认才写 `tasks`。积分同理：AI 给难度与理由，**数字由 `rubric.ts` 纯函数算**。原因：R4 的「审核」是产品语义的一部分，不是可选步骤；且模型输出数字不可复现、无法解释、会漂移。

---

## 3. 进程与窗口拓扑

```
┌──────────────────────── Main Process（Node，唯一写库者）────────────────────────┐
│                                                                                │
│  windows/          mainWindow (1440×920)      hudWindow (透明置顶，双模式)       │
│  ipc/              registerHandlers.ts  ← ipcMain.handle('domain:action')       │
│  services/         taskService ─ messageService ─ pointsService                 │
│                    reminderService ─ aiService                                  │
│  db/               better-sqlite3（同步 API） + migrations/                     │
│  scheduler/        reminderScheduler（30s 心跳 + 精确 setTimeout 到最近一条）    │
│  ai/               glmClient · pipelines/ · prompts/ · schema.ts(zod)           │
│  bus.ts            DomainEvent 广播中心（webContents.send 到所有窗口）           │
└───────────────┬──────────────────────────────────────┬─────────────────────────┘
                │ contextBridge (preload)              │
        ┌───────┴────────┐                    ┌────────┴─────────┐
        │ Renderer: main │                    │ Renderer: hud    │
        │ React + zustand│                    │ React + zustand  │
        │ 左会话 / 右四块 │                    │ dock-bar / pod   │
        └────────────────┘                    └──────────────────┘
```

两个渲染进程是**两份独立的 JS 运行时**，不共享内存。它们的唯一共同真相是主进程的 SQLite 与 `DomainEvent` 流。这一点必须在任务分派时写清楚，否则会出现"我在 A 窗口改了 zustand，B 窗口不同步"的典型事故。

### 3.1 目录与所有权

```
taskloop/
├─ electron.vite.config.ts      # 三入口：main / preload / renderer(main,hud)
├─ package.json
├─ src/
│  ├─ shared/                   # ★ 契约层，只有架构负责人可写
│  │  ├─ types/{domain,ipc,ai}.ts
│  │  ├─ channels.ts            # IPC 通道名常量
│  │  ├─ points/rubric.ts       # 积分公式（纯函数，主/渲染共用）
│  │  └─ errors.ts
│  ├─ main/
│  │  ├─ index.ts, bus.ts, windowManager.ts
│  │  ├─ windows/{mainWindow,hudWindow,tray}.ts
│  │  ├─ db/{connection.ts,migrations/,repositories/}
│  │  ├─ services/{task,message,points,reminder,ai}Service.ts
│  │  ├─ ipc/{registerHandlers,guards}.ts
│  │  ├─ scheduler/reminderScheduler.ts
│  │  └─ ai/{glmClient.ts,pipelines/,prompts/,schema.ts}
│  ├─ preload/index.ts
│  └─ renderer/
│     ├─ main/{app,features/chat,features/tasks,features/calendar,features/points,components,styles}
│     └─ hud/{HudRoot.tsx,HudPanel.tsx,shells/{DockBar,FloatPod}.tsx}
└─ docs/
```

---

## 4. 核心数据流

### 4.1 创建任务（R1-R4）

```
用户在会话输入（文字/图片）
  → messageService.append(user)            [写 messages, 广播 message.appended]
  → aiService.parse(messageId)             [组装多模态 payload，调 GLM]
      ↓ 返回 ParseResult（intent + reply + tasks[]，zod 校验）
  → 计算每张卡片的 points_planned       [shared/points/rubric.ts]
  → messageService.append(assistant, kind='task_draft', meta=卡片+原始JSON)
                                           [广播 message.appended]
  → 用户在会话里：确认 / 改字段 / 丢弃
  → taskService.promoteDraft(draftMsgId, patch)
                                           [写 tasks(status='todo')，广播 task.created]
  → 左右两侧 + 悬浮条同步更新           [同一事件]
```

关键点：**草稿不是任务**。`tasks` 表里没有 draft 行；草稿活在 `messages.meta_json` 里，确认后才生 `tasks` 行。这样可以避免"一半的 tasks 是废稿"污染任务列表与日历统计，也让「丢弃」变成零成本操作。

### 4.2 完成任务与记账（R5）

```
用户："报告写完了" 或 在卡片上点「完成」
  → aiService.review(taskId, userText, evidence[])
      ↓ ReviewVerdict { verdict:'pass'|'partial'|'fail', quality, reason, followup }
  → 若 pass/partial 且用户确认：
      pointsService.award(taskId, quality)
        ├─ 在 point_ledger 插一行（唯一索引防重复发分）
        ├─ 更新 tasks.points_awarded / status='done' / completed_at
        ├─ upsert daily_stats
        └─ 广播 points.changed + task.updated
```

### 4.3 提醒（R6）

调度器到点 → 写 `messages(kind='reminder', role='system')` → 广播 → 会话流里出现一条提醒气泡 + 悬浮条脉冲 + 可选系统通知。
**提醒必须进会话流**：如果只弹系统通知，用户回头翻会话找不到这条提醒，就失去了"会话是唯一入口"的一致感。

---

## 5. 技术选型与理由

| 项 | 选择 | 理由 / 注意 |
|---|---|---|
| 构建 | `electron-vite` | 原生支持 main/preload/多个 renderer 入口，省掉自己拼多页配置 |
| 状态 | `zustand` | 双窗口都是"从事件流 hydrate"，不需要 React Query 这类请求缓存 |
| DB | `better-sqlite3` | 同步 API 在主进程最省心；**必须配 `electron-rebuild`**，这是本项目第一个必踩的坑 |
| 样式 | Tailwind CSS + CSS 变量 | 悬浮窗要与主窗共享设计 token |
| 校验 | `zod` | AI 输出必须过 schema，不信任模型返回 |
| 打包 | `electron-builder`（NSIS） | `asarUnpack` 要放 native 模块 |
| 图标 | `lucide-react` | 轻、线性，与工具类产品气质一致 |

---

## 6. 主要风险（实现方必读）

| 风险 | 表现 | 规避 |
|---|---|---|
| better-sqlite3 ABI 不匹配 | `NODE_MODULE_VERSION` 报错，开发能跑打包挂 | 装完立刻 `electron-rebuild -f -w better-sqlite3`，并把 postinstall 写进 package.json |
| 透明窗黑底/闪烁 | Windows 上 `transparent:true` 偶发不透明 | 设 `backgroundColor:'#00000000'`；异常时对该窗口 `app.disableHardwareAcceleration()` 作为兜底开关 |
| 置顶盖住全屏应用 | 用户看视频/开会时悬浮条压在上面 | 监听全屏状态（`screen` + 窗口 bounds 比对）自动隐藏；`setAlwaysOnTop(true,'pop-up-menu')` 而非 `screen-saver` |
| 多显示器位置漂移 | 拔掉副屏后悬浮窗跑到屏幕外 | 存 `displayId`，启动时校验该 display 是否存在，不在则归位主屏 |
| AI 返回非 JSON | 模型加 markdown 围栏或多说废话 | `response_format` 指定 json；剥围栏后 zod 校验；失败重试 1 次，再失败降级为 `kind='error'` 消息，**不崩** |
| 图片过大 | base64 撑爆请求 / 延迟高 | 入参前统一压到长边 ≤1568px、JPEG q80，落盘存原图 |
| GLM 多模态能力假设 | 接错模型导致图片识别静默失败 | **接入前先跑一次真实调用验证**（见 03 §6），不要凭文档假设 |
| 每日任务重复发分 | 沿用旧的唯一索引，第 2 天发分直接被拒 | 索引必须拆成 `occurrence_id IS NULL` 互斥的两条（01 §2.4），且要有"连续两天都能发分"的测试 |
| 每日任务把日历刷满红点 | 一个月 30 天全红，红点失去意义 | 每日任务不参与红点（待确认 Q2）；或只用空心圈区分完成态 |
| 外部渠道拖垮提醒 | 邮件没配/超时就整条提醒失败 | 渠道独立 try/catch，`inapp` 永远先发且不可关（02 §6.2） |
| 任务类型判错 | 提醒时刻全错（活动提前 7 天 vs 限时提前 1 天） | 分类规则写进 prompt 且"判不清默认 deadline"（03 §4.1） |
| 邮件提醒延迟或被当垃圾邮件 | 前 1 小时提醒可能压到截止后才看到 | 设置页要求填收件人后**必须点一次 `[测试]` 并确认收到**；`inapp`+`toast` 永远并行发，不单靠邮件 |
| 视觉模型能力假设 | 图片请求失败或模型没真看图 | **接入前先跑一次真实带图调用验证**（03 §6），结果写进 `ai.health.multimodal` |
| 证据流被绕过 | 用户在 UI 之外直接调接口 | `taskService.complete` 硬校验，不能只在 UI 拦（01 §3、05 W7） |

**关于 harness（已决定暂不实施）**：`06-HARNESS.md` 保留为参考设计，不进入施工范围。因此"harness 单点故障""harness 放本机导致睡眠期间提醒丢失"这两类风险本版**不存在** —— 代价是提醒不再有"常开机器也能发"的能力，手机端只能靠邮件。哪天要上 harness，这两条风险会重新生效，届时必须放到常开机器上。

---

## 7. 待决事项（未拍板不实现）

### 7.1 已拍板（2026-10-27）

| 编号 | 问题 | 结论 |
|---|---|---|
| Q1 | 每日任务怎么计分 | **固定低分 + 连续里程碑**：每日 1 分，连续 7 天 +5、30 天 +20 |
| Q2 | 红点标哪些任务 | **只标限时 + 活动**；每日任务不进红点（否则整月全红，失去信息量） |
| Q3 | 每日任务提醒时间 | 每个每日任务自带 `dailyTime`，默认 `21:00`，草稿卡片上可改 |
| Q4 | 外部提醒通道 | **邮件为主**（`mail`，可发 QQ 邮箱，手机有提示）。`webhook` 留接口不接真实服务；harness 暂缓（02 §6.3） |
| Q5 | 积分额度档位 | **B 中档**：5/10/20/35/50，每日 1 分，月典型 ≈ 320 分 |
| Q6 | 完成是否必须附证据（S4） | **必须**。`requiresEvidence` 由 AI 判定，缺证据停在 `reviewing` 不入账 |
| Q7 | 模型与推送是否走自建 harness | **暂不实施，设计保留。** 用户 2026-10-28 决定：harness 想法留着，通知走邮箱即可。模型走 `zhipu` 直连，外部提醒走 `mail`；`AiProvider` / `NotificationChannel` 两个接口按可插拔设计，以后接 harness 不改上层 |

### 7.2 仍待确认

| 编号 | 建议 | 状态 |
|---|---|---|
| S1 | 每日积分上限 + 超额衰减 | 不做。B 档下一个月约 320 分，未见刷分风险；先观察两周再说 |
| S3 | 积分可消耗（兑换 / 撤销） | 第一版不做 |
| S5 | 会话支持多 thread | 第一版不做 |
| S6 | 逾期自动降分 / 任务顺延 | 第一版不做，`overdueDays` 参数已预留为 0 |

---

## 8. 版本与变更流程

1. 接口冻结前（当前阶段）：`src/shared/**` 由架构负责人变更，改完在此文档末尾追加变更记录。
2. 接口冻结后：任何一方要改契约，写「变更单」（改什么 / 为什么 / 影响哪些模块），确认后**先改 shared 再改实现**，禁止实现方自己加字段。
3. 数据库迁移只能由数据层负责人添加，文件名 `NNN_desc.sql`，只增不改。

### 变更记录

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-10-27 | v0.1 | 建立架构基线；确认四项技术选型 |
| 2026-10-27 | v0.2 | 新增 R10-R16：任务三分类、日历红点与按日展开、分类提醒策略、多渠道醒目提醒、积分额度改为可协商。**破坏性变更**：`tasks` 增加 `type`/`repeatRule`/`reminderOffsets`，新增 `task_occurrences` 表，`point_ledger` 增加 `occurrenceId` 并拆分唯一索引 |
| 2026-10-27 | v0.3 | 拍板 Q1-Q5：每日 1 分 + 连续里程碑、红点只标限时与活动、每日提醒默认 21:00、B 中档额度、外部提醒走 `mail → webhook` 路线（不做 QQ 官方机器人）。W8B 范围据此收敛 |
| 2026-10-27 | v0.4 | 拍板 Q6/Q7：完成审核强制证据（`requiresEvidence` + `evidence_json`，缺证据停在 reviewing 不入账，取消"先入账再追问"的口子）；模型接入改为 `AiProvider` 双实现（`zhipu` / `harness`），新增 06 文档。通知渠道 id `qq` 改为 `webhook`（QQ 由 harness 在下游实现） |
| 2026-10-28 | v0.5 | 用户决定：**harness 保留想法、暂不实施**，通知走邮箱。据此收敛范围：W4 只实现 `zhipu` 直连（`harnessClient` 不写，接口保留）；W8B 验收只到 `mail`（`webhookChannel` 只做最小实现，不接真实服务）；06 文档转为参考设计。**接口无破坏性变更**，`AiProvider` / `NotifyChannel` 签名不变 |
