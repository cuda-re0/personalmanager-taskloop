# 05 · 任务拆分与验收

> 用法：把某一个 `W` 连同它依赖的前置文档**整段**发给对应的 AI，不要只发一句"做任务列表"。
> 每个 W 都写明了「只许改哪些目录」和「验收标准」——验收不通过就不算交付。
>
> **已经写成可直接发出去的开工词**（自包含，含路径、必读章节、禁令、自检表）：第 0 波 `W0`，第 1 波 `W1` `W2` `W3` `W4` `W6B-UI` `W9-UI` —— 见 [`docs/kickoff/`](kickoff/README.md)。第 2 波之后的开工词等前一浪收工后再生成，因为要引用上游真实接口。

---

## 0. 依赖图

| 阶段 | 模块 | 依赖 | 可否并行 |
|---|---|---|---|
| W0 | 脚手架 | — | 阻塞全部 |
| W1 | 数据层 | W0 | 与 W2 / W3 并行 |
| W2 | IPC 与事件总线 | W0 | 与 W1 / W3 并行 |
| W3 | 会话 UI | W0 | 与 W1 / W2 并行（用 mock 数据） |
| W4 | AI 接入 | W0、W2 的空壳 | 与 W1 / W3 并行 |
| W5 | 草稿 → 任务 | W1、W2、W3、W4 | — |
| W6 | 积分（含每日计分） | W1、W2、W5 | 与 W6B 并行 |
| W6B | 日历红点与按日展开 | W1、W2、W5 | 与 W6 并行 |
| W7 | 完成审核 | W4、W5、W6 | — |
| W8 | 提醒（按类型） | W1、W2、W5 | 与 W7 并行 |
| W8B | 外部通知渠道 | W8 | — |
| W9 | 悬浮窗 | W2、W3（复用组件） | 与 W6 / W7 / W8 并行 |
| W10 | 打包 | 全部 | — |

关键路径：`W0 → W1 → W5 → W6 → W7 → W10`。要提速就压这条链，别在 W9 上堆人。

**分工建议（若同时派多个 AI）**：数据层一个、AI 一个、渲染（W3+W6B+W9）一个、服务与提醒一个。四个人时 W6 和 W8 会撞——`pointsService` 与 `reminderService` 都在 W5 之后改 `taskService`，冲突高发区。

---

## W0 · 脚手架（阻塞项，先做完）

**目标**：两个窗口能同时起来，`shared` 契约能编译，SQLite 能写能读。

**只许改**：以 `docs/kickoff/00-W0-脚手架.md` 的「你能改的文件」清单为**唯一权威**（含 `package.json`、`package-lock.json`、各配置文件、`.gitattributes`、两个窗口入口、`src/shared/**`、`src/renderer/shared/styles/tokens.css`）。本节不另列一份，避免两处清单不一致、每轮审核都要解释越界。

**必须做到**

1. `electron-vite` 三入口：main / preload / renderer[main, hud]。HUD 用独立 HTML 入口。
2. TS `strict: true`，路径别名 `@shared → src/shared`，两个渲染进程都能用。
3. ESLint + Prettier，`npm run lint` 干净。
4. `better-sqlite3` 装上并 `electron-rebuild`，能在 main 里 `new Database(':memory:')` 跑通。
5. 主窗开一个 1440×920 空窗口；HUD 开一个 300×32 透明置顶空窗口（**这是骨架占位尺寸，不是最终形态**；`dock-bar` 的全宽规格在 `04-UI-SPEC.md` §5.2，由 W9 实现）。
6. `src/shared/types/*.ts`、`channels.ts`、`points/rubric.ts` 按 02 文档建好，能编译。
7. `postinstall` 包含 rebuild；`npm run dev` / `npm run build` 都可用。
8. **预留接线点**（并行调度必需）：`src/main/index.ts` 里写好 `initDb()` 与 `registerIpcHandlers()` 的调用行，并各自建一个空实现文件（`src/main/db/index.ts`、`src/main/ipc/index.ts`，函数体只有 `// TODO(W1)` / `// TODO(W2)`）。这样 W1、W2 各改自己的文件，**不需要动 `src/main/index.ts`，避免两人抢同一个文件**。

**验收**：`npm run dev` 后两个窗口同时出现；主窗控制台能 `console.log(RUBRIC_VERSION)`；`npm run lint` 零错误；`npm run build` 成功；`initDb()` 与 `registerIpcHandlers()` 都被调用到（打日志确认）。

**禁止**：不要开始写业务 UI、不要写 AI 调用、不要动 `src/shared` 里的类型定义（只许照抄，不许"优化"）。

**开工词**：[`docs/kickoff/00-W0-脚手架.md`](kickoff/00-W0-脚手架.md)

---

## W1 · 数据层

**只许改**：`src/main/db/**`、`src/main/services/{task,message,points}Service.ts` 的**数据访问部分**、`tests/db/**`、`tests/shared/**`

**交付**

1. `connection.ts`：单例连接、WAL、`foreign_keys=ON`、`migrate()` 顺序执行未应用迁移。
2. `migrations/001_init.sql`：01 文档全部建表语句、索引、唯一索引，一字不改。**注意 2 条条件唯一索引**（`uq_ledger_task_done` 带 `occurrence_id IS NULL`，`uq_ledger_occurrence`）与 `uq_occurrence_task_day`。
3. `repositories/`：`taskRepo`、`occurrenceRepo`、`messageRepo`、`ledgerRepo`、`reminderRepo`、`statsRepo`、`settingRepo`。全部同步方法，入参出参用 `src/shared/types/domain.ts` 的类型（做 snake_case ↔ camelCase 映射，映射逻辑只写在一处）。
4. `occurrenceService.ensureRange(from, to)`：按 §2.1.3 规则幂等生成每日任务 occurrence。
5. 事务封装 `tx(fn)`：`db.transaction` 透传。
6. 状态机校验 `assertTransition(type, from, to)`，非法抛 `AppError{code:'CONFLICT'}`。daily 类型不接受 `reviewing`/`done`。
7. `rebuildDailyStats()`。
8. **测试基建 + `tests/shared/rubric.test.ts`**：配 vitest（`npm test` 可跑），并按 02 §5.2 的示例表逐行断言 `computePlannedPoints` 六组值、`computeAwardedPoints` 的质量系数与逾期扣分。审核发现积分公式此前无任何测试，而它是全产品的分值来源，W1 建测试基建时顺手补上，边际成本接近零。
   **只测不改**：`src/shared/points/rubric.ts` 若与 02 §5.2 不一致，报告，不要自行修正。

**验收（写成自动化测试，必须绿）**

- [ ] 建库 → 建任务 → 查任务，字段全等（含 `type` / `reminderOffsets`）。
- [ ] `todo → done` 直跳被拒；`todo → doing → reviewing → done` 通过。
- [ ] 同一限时任务插两条 `task_done` 流水，第二条被唯一索引拒绝。
- [ ] **同一每日任务连续两天各发一次分，两次都成功**（这条是本期最容易挂的地方，必测）。
- [ ] 同一每日任务同一天发两次分，第二次被 `uq_ledger_occurrence` 拒绝。
- [ ] `ensureRange` 连续调用 3 次，occurrence 数量不增长（幂等）。
- [ ] `ensureRange` 不生成过去日期、不生成 `active_to` 之后的日期。
- [ ] 删父任务，子任务级联删除；`point_ledger.task_id` 变 NULL（不删流水）；`task_occurrences` 级联删除。
- [ ] 1000 条任务 + 5000 条流水 + 3000 条 occurrence 的 `task.list`、`calendar.dayIndex`、`points.monthStats` 各 < 20ms。
- [ ] `day` 字段在东八区 00:30 写入时，落在当天而非前一天。
- [ ] `npm test` 可跑，`rubric.test.ts` 的六组积分与质量系数断言全绿。

**禁止**：不要在 service 里调 AI；不要改 DDL 结构（发现设计问题提变更单）。

---

## W2 · IPC 与事件总线

**只许改**：`src/main/ipc/**`、`src/main/bus.ts`、`src/preload/index.ts`、`package.json`（仅加 `zod`；`package-lock.json` 是加依赖的必然伴随，一并豁免）

**交付**

1. `bus.ts`：`broadcast(event: DomainEvent)` 向全部存活窗口 `webContents.send('bus:event', event)`。传输层可注入（测试用），默认实现枚举 `BrowserWindow.getAllWindows()`。
2. `createHandlers(ipc)`：**不直接吃 `ipcMain`，而是接收一个 `{ handle(ch, fn) }` 接口**——测试传假实现就能把整张表跑起来。`src/main/ipc/index.ts` 的 `registerIpcHandlers()` 只是 `createHandlers(ipcMain)`。
3. `envelope.ts`：纯函数，`AppErrorException → {ok:false,error}`、未知异常 → `UNKNOWN` + `console.error` 全量堆栈。**永远不 throw 到 ipcMain 外面**。
4. `guards.ts`：zod 校验入参，失败返回 `INVALID_INPUT` /「请求参数格式不正确」（04 §1.1 已登记）。只拦形状，业务规则仍归 service。
5. preload：`window.api` 形状与 02 §4 一致（已在 `src/preload/index.ts` 声明好，本轮只补缺口）。

**通道归属（51 个 api 方法 + 1 条 bus 事件 = 52，本轮只接 25 条）**

| 归属 | 通道 | 数量 |
|---|---|---|
| **W2 本轮接** | `app` 全部 4 条；`task` 除 `promoteDraft` / `complete` 外 10 条；`occurrence.today` / `listByRange`；`calendar` 2 条；`msg.list`；`points` 全部 6 条 | 25 |
| W5 | `task.promoteDraft`（v0.14 改判，原误标 W6；理由见 kickoff/08 v0.14） | 1 |
| W6 | `task.complete`、`occurrence.complete` / `undo` / `skip` | 4 |
| W4 | `msg.send` / `retry`、`ai` 全部 4 条 | 6 |
| W8 | `reminder` 全部 6 条（`reminders` 表在 W8 前恒为空，接上去也是空数据） | 6 |
| W9 | `channel` 全部 3 条、`hud` 全部 5 条 | 8 |
| W11 | `attachment.add`（service 已由 W11 交付；handler 在 `registry.ts`，归附件 UI 轮随 W2 补丁注册） | 1 |

**未接的通道一律不注册**（不放假 handler、不返回假数据）。渲染层调它们会当场收到 Electron 的 "No handler registered"，这是开发期错误、不该被伪装成业务错误。`WIRED` / `NOT_WIRED` 两张表要作为**代码里的数据**导出，并配一条覆盖测试：两张表的键集合并集必须等于 `CH` 的全部叶子、且不交叠——这样下一个新通道加进 `channels.ts` 却没人接，测试会红。例外：`bus:event` 是单向事件通道（主进程 → 渲染层），不在 `Api` 方法里，两张表都**不**含它。

**已知缺口（不阻塞，但要写进交付报告）**

- `task.setReminderOffsets` 只写 `tasks.reminder_offsets`，**不创建 `reminders` 行**。W8 的 `syncForTask` 落地前，`reminders` 表恒为空——这也是 `reminder.*` 六条整块划给 W8 的原因。
- `Bootstrap.channels` 恒为 `[]`（W9 前，见 02 §3.1）。

**验收**

- [ ] 主窗调用 `api.app.getBootstrap` 拿到真实数据（不是假对象），字段一个不少。
- [ ] 主窗发 `task.createManual` → HUD 通过 `onEvent` 收到 `task.created`，HUD 显示该标题。
- [ ] 传 `{ id: 123 }` → `{ok:false, error:{code:'INVALID_INPUT'}}`，不抛异常、不白屏。
- [ ] 关闭 HUD 后再广播事件 → 不报错、主进程不崩。
- [ ] `occurrence.today` 首次调用（会补行）广播了 `occurrence.created`；第二次调用不广播。
- [ ] 通道覆盖测试：`WIRED ∪ NOT_WIRED == CH 全部叶子`。

**禁止**：渲染层不许出现 `require('electron')`；不许在 handler 里直接写 SQL（走 service）；不许在未接的通道上造返回值。

---

## W3 · 会话 UI

**只许改**：`src/renderer/main/features/chat/**`、`src/renderer/main/components/**`、`src/renderer/shared/styles/**`

**交付**

1. 消息流：虚拟滚动（消息 > 200 条时性能不塌）、自动滚到底、向上翻页加载。
2. 五种消息组件：`text` / `task_draft` / `task_review` / `reminder` / `error`（04 §3.1）。
3. 草稿卡片组件（04 §3.2）——**这是本阶段最重要的一块**，含就地编辑、分值徽标、missing_info 标签、确认/丢弃。
4. 输入区：多行自适应、Enter 发送、粘贴图片、拖入文件、缩略图条、发送中状态。
5. markdown 渲染：段落/列表/粗体/行内代码，**禁用 HTML 注入**（不做 `dangerouslySetInnerHTML` 不 sanitize 的事）。
6. 空会话状态（用 04 §7 那句，等你确认后固定）。

**验收**

- [ ] 传入 mock 消息数组，五种类型都能正确渲染，无控制台警告。
- [ ] 草稿卡片改难度，"分值徽标"立刻变化（走 `api.points.preview`）。
- [ ] 粘贴一张截图，出现缩略图，可删除，发送后气泡里显示图片。
- [ ] 1000 条消息滚动 60fps。
- [ ] 消息里的 `<script>` 或 `![x](javascript:...)` 不被执行。

**禁止**：不要在组件里直接算积分（必须调 `rubric` 或 `points.preview`）；不要写 04 §1 之外的新文案。

---

## W4 · AI 接入

> **v0.22 起以 `docs/kickoff/16-W4-AI接入.md` 为准**，本节只保留归属与验收要点。
> 原「第 0 步自己去验多模态」已由架构方做完（结论在 `03 §9`），施工方只需复核一次。

**只许改**：`src/main/ai/**`、`src/main/services/aiService.ts`、`scripts/verify-ai.mjs`、`docs/verify-ai-result.md`、`tests/ai/**`，
以及 `src/main/ipc/{registry,guards}.ts` **里属于这 6 条通道的那几行**（v0.22 新开授权：否则这 6 条通道永远没人接）。

**前置**：`03 §9` 的实测结论已就位（含 key 的三级读取优先级）。**验证不通过，先停下来报告，不要自己换模型。**

**交付**

1. `AiProvider` 接口（03 §3.0）+ **一个实现**：
   - `glmClient.ts`：直连智谱，`chatJson` 带 zod 校验、重试 1 次、超时、Abort。
   - `harnessClient.ts`：**本版不写。** 只保证 `aiService` 依赖 `AiProvider` 而非具体类，以后补文件即可（接口签名已冻结）。
   - `aiService` 按 `settings['ai.provider'].name` 取实现，**只接受 `'zhipu'`**；填 `'harness'` 报 `CONFIG` 错误而不是静默回退（避免"以为在用 harness，其实在直连"）。
2. `prompts/`：`system.base.md`、`parse.system.md`、`review.system.md`、`parse.fewshot.json`。**prompt 必须在主程序**，将来接 harness 也不许挪出去。
3. `schema.ts`：`ParseResultSchema`（含 `type`、`requires_evidence`）、`ReviewResultSchema`（含 `verdict: 'need_evidence'`）。
4. `pipelines/parse.ts`：消息 → 多模态 payload → ParseResult → `TaskDraft[]`（补 `localId`、`pointsPlanned`、按 type 的 `reminderOffsets`）。
5. `pipelines/review.ts`：接收 `evidence[]`，按 03 §4.2 判定。
6. `aiService`：写 assistant 消息、更新 `ai.status` 事件、失败落 `error` 消息。
7. `ai.health`：返回 `{ configured, provider, model, multimodal }`；`multimodal` 必须靠**一次真实带图调用**探测，不能读配置猜。
8. API Key 走安全存储（`keytar` 或 Electron `safeStorage`），不落 DB 明文。

**验收**

- [ ] "明天下午三点前把季度报告初稿写完" → 1 个 draft，`type='deadline'`，`due_hint` 非空且合理，`requires_evidence=true`。
- [ ] "每天早上背单词" → `type='daily'`，`daily_time_hint=null`，`requires_evidence=false`。
- [ ] "下周三考英语六级" → `type='event'`，提醒偏移为 7/3/1 天。
- [ ] 一张含三条待办的截图 → 最多 3 个 draft。
- [ ] 一句"今天天气不错" → `intent='chat'`，`tasks=[]`，正常回复。
- [ ] 一句"报告写完了" → `intent='review_task'`。
- [ ] 断网/AI 报错 → 会话出现 error 气泡，带 `[重试]`，界面不崩，`ok:false` 不抛异常。
- [ ] 故意让模型返回带 ```json 围栏的文本 → 能被正确剥离解析。
- [ ] `settings['ai.provider']` 填 `'harness'` → 设置页显示"未实现"，不崩、不静默降级。
- [ ] 全流程无任何 key / token 出现在控制台输出。

**禁止**：不要让模型输出分数；不要在 prompt 里写"给 20 分"这种示例（会被照抄）；不要把 prompt 挪进 harness。

---

## W5 · 草稿 → 任务

**只许改**：`src/main/services/taskService.ts`、`src/renderer/main/features/tasks/**`、`src/renderer/main/features/chat/**`（仅限 v0.14 授权的两处接线，见 kickoff/09）、`src/main/ipc/registry.ts`（仅 promoteDraft 一条的注册与 guard）、`scripts/seed-dev-draft.mjs`（开发造数）、`tests/**`

**交付**

1. `task.promoteDraft`：读 `messages.meta_json` 里指定 draft → 写 `tasks`（status `todo`）→ 把 draft 的 `steps` 写成子任务 → 广播 `task.created`（含子任务各一条）。
2. **按 type 分支落库**：
   - `deadline` / `event`：写 `due_at`，无 occurrence
   - `daily`：写 `daily_time` / `repeat_rule` / `active_from`，并立刻 `occurrenceService.ensureRange(今天, +3天)` 生成头几天
3. **写操作广播**：promoteDraft / createManual 在 handler 层广播 `task.created`（含子任务各一条）+ `occurrence.created`（daily 的 `ensureRange` 差集）。**提醒的 `syncForTask` 归 W8**（05 W2 已知缺口）：W8 落地前 reminders 恒空，W5 不实现、不调用、渲染层不拼（v0.14 改判，原"落库后立刻调、不能等 W8"作废）。
4. 草稿消息的 `meta_json` 里把该 draft 标记 `promoted: true`，避免重复确认。
5. 右栏 ①「当前任务」列表（04 §4①）：三组分列、排序、就地展开详情、步骤勾选、完成按钮。
6. `task.update` / `task.transition` / `task.reorder` / `task.setReminderOffsets` 的 UI 接线。改 `due_at` 或 `reminderOffsets` 后必须重新 sync 提醒。**注意（W2 交付时指出）：handler 层没有 sync 钩子**——`setReminderOffsets` / `createManual` / `update` 都只写 `tasks` 列、不建 `reminders` 行。这条"重新 sync"目前只能等 W8 的 `reminder.syncForTask` 落地后接线，W5 不许在渲染层自己拼提醒逻辑。

**改类型的语义（已定，2026-10-28）：落库后不可改。**

04 §3.2 的"类型可就地修改"只针对**草稿卡片**（未落库的 `TaskDraft`，纯渲染层状态，W3 已实现：换该类型默认提醒偏移 + `snapDifficulty` + 重算分值）。右栏详情（04 §4①）本来就只有 `detail_md` / 步骤 / 提醒偏移 / `[完成]` 四项，没有类型入口。

所以 W5 不要做"改类型"按钮，`TaskPatch` 也不要加 `type`（契约 02 §3.2）。用户建错类型的出口是 `task.remove`（软删）+ 重新建，旧任务连同流水与 occurrence 留在历史里。理由写在 02 §3.2：改类型要连带难度归位、清字段、重排 `reminders` 行、补 occurrence 四件事，其中提醒重排依赖 W8，现在做只会留下按旧类型排好的提醒。

**验收**

- [ ] 确认草稿 → 会话卡片变已确认态 + 右栏列表立刻出现（HUD 同步出现顺延 W9——HUD 未开工）。
- [ ] 同一 draft 点两次确认，只生成一个任务。
- [ ] 确认一条"每天背单词"→ 右栏「每日」组出现，今日 occurrence 已生成，且**日历上不出红点**。
- [ ] 展开任务、勾 2/3 个步骤、点完成 → 状态走 `reviewing`，出现确认条而非弹窗。
- [ ] 拖动排序后重启应用顺序保持。
- [ ] 把限时任务的截止时间从周五改到周六，`reminders` 表里的 `fire_at` 跟着变（不能残留旧行）。**（v0.14：顺延 W8 验收——syncForTask 未落地前 reminders 恒空）**

---

## W6 · 积分（含每日任务计分）

**只许改**：`src/main/services/pointsService.ts`、`src/main/services/taskService.ts`（仅 `completeTask` / `undoCompletion` 两个新函数）、`src/main/db/occurrenceService.ts`（仅 `complete` / `undo` / `skip` 三个新函数）、`src/main/ipc/registry.ts` 与 `guards.ts`（仅 `task.complete` + `occurrence.complete/undo/skip` 四条）、`src/shared/points/rubric.ts`（**只读，公式不许改**）、`src/renderer/main/features/points/**`、`src/renderer/main/features/tasks/**`（仅确认条接线）、`tests/**`（v0.16 授权扩展，理由见 kickoff/08 v0.16 与 kickoff/11）

**交付**

1. `pointsService`：`balance()`、`award(taskId, quality)`（事务内写 ledger + 更新 task + upsert daily_stats + 广播）。
2. `awardOccurrence(occurrenceId)`：完成每日任务这一次 → 写 ledger（带 `occurrence_id`）→ 更新 streak → 若命中里程碑另写一条 `streak_bonus` → upsert stats。
3. `undoOccurrence(occurrenceId)`：写负流水冲销，streak 回退到上一天的真实值（用 occurrence 反查，不要简单减 1）。
4. 撤销限时/活动完成（`task.undo`，v0.19）：`done → doing`、原发分行标 `reversed_at`、写等额负流水，24h 窗口内才允许。
5. 右栏 ③「积分」区块 + ④「明细」区块（04 §4③④）。
6. `points.preview` / `points.streakPreview` 纯计算通道。
7. 分值表从 `settings['points.*']` 读，**禁止硬编码**；启动时若无配置写入 `DEFAULT_CONFIG`。

**验收**

- [ ] 完成任务 `medium` → planned = **20**（只看难度，`estimateMin` 不进公式），`met` → 入账 20，余额 +20，明细出现一行。
- [ ] 完成任务 `easy` 且提前 30 小时确认 → planned = **10**，效率系数 ×1.1 → 入账 **11**，显示为 `11` 而不是 `11.00`。
- [ ] 完成任务 `hard` 提前 96 小时且质量超预期 → `35 × 1.2 × 1.15` = **48.3**，余额出现小数且显示为 `48.3`。
- [ ] 连续完成 4 个小数任务，余额 `SUM(delta)` 不出现 `319.99999999999994` 这种浮点尾巴（`roundPoints` 生效）。
- [ ] 重复完成同一限时任务不会二次入账（前端禁用 + 后端唯一索引双保险）。
- [ ] 撤销完成 → 余额回落，明细出现 `-20`。
- [ ] **撤销后重做**：完成 → 撤销 → 走回 `reviewing` → 再完成，正常入账 20，不报「已经发过完成分了」（v0.19）。
- [ ] **撤销后重做（每日）**：打卡 → 撤销 → 同一天再打卡，正常入账，不报「这一天的打卡已经发过分了」（v0.19）。
- [ ] 撤销超过 24 小时的完成记录 → 报「超过 24 小时的完成记录不能撤销」，状态与余额都不动（v0.19）。
- [ ] 每日任务连续完成 7 天，第 7 天明细出现两条：`task_done +1` 与 `streak_bonus +5`。
- [ ] 第 8 天漏做，第 9 天完成 → `streak_current = 1`，不给里程碑。
- [ ] 撤销第 7 天的完成 → streak 回到 6，`streak_bonus` 被冲销。
- [ ] 改 `settings['points.difficultyBase']` 后，历史流水金额不变，新任务按新表算。

---

## W6B · 日历（红点与按日展开）

**只许改**：`src/renderer/main/features/calendar/**`、`src/renderer/main/index.tsx`（仅挂载日历区块）、`tests/renderer/**`。**主进程零改动**：`calendar.dayIndex / dayDetail` W1/W2 已接通并实现（v0.16 修正：原写的 `ipc/handlers/calendar.ts` 不存在），本线纯渲染层，口径问题只报告。

**交付**

1. `calendar.dayIndex(year, month)`：按 01 §4.1 的单表查询一次返回当月红点，**只含 `deadline` / `event`**。
2. `calendar.dayDetail(day)`：返回该日限时/活动任务，按本地时刻升序。
3. 月视图组件（04 §4②）：7 列、红点行、完成变空心圈、今日描边、月份切换。
4. 点击日期 → 浮层展开当日任务列表（04 §4②），点击外部关闭，点行跳转任务。
5. 切月只发一次 `dayIndex`，不做缓存预热、不调 `ensureRange`（那是每日任务的事，与日历无关）。

**验收**

- [ ] 当月有 3 个限时任务、1 个活动任务，红点出现在正确的日子。
- [ ] 每日任务**不产生**任何红点。
- [ ] 某日全部完成 → 红点变空心圈；新增一个未完成任务后变回实心。
- [ ] 点某日弹出列表，条目数、时间、类型标签、分值都对。
- [ ] 点无任务的日期不弹窗。
- [ ] 切月来回三次，红点数据不重复、不丢失。
- [ ] 一个月 30 个格子只发了 1 次 `dayIndex` 请求（DevTools 确认）。

---

## W7 · 完成审核（含证据闸门）

**只许改**：`src/main/services/taskService.ts` 的 `complete` 分支、`src/main/ai/pipelines/review.ts`、`src/renderer/main/features/chat/ReviewCard.tsx`

**交付**

1. 用户说"做完了"或点完成 → 若 `requiresEvidence` 且无证据 → 直接返回 `CONFLICT` + 追问消息（**不调模型也行，省一次钱**）。
2. 有证据（或不需要证据）→ 走 `ai.review` → 按 03 §4.2 映射表动作 → `task_review` 卡片。
3. `taskService.complete` 里**硬校验**证据闸门，不能只靠 UI 拦。
4. `task.addEvidence` + `[重新审核]` 的往返流程。
5. `partial` 入账 60%，任务回 `doing`，卡片列出缺口。
6. 连续 3 次 `need_evidence` 后出现 `[直接标记完成（不计分）]`，走 `task.complete({ noPoints: true })`：写 `completed_at`、不写 ledger、返回的 `entry` 为 `null`（02 §3.2）。**不能走 `transition('done')`**，那条路已被硬拦成 `CONFLICT`。
7. 审核卡片四种状态（04 §3.3）。

**验收**

- [ ] 需要证据的任务，点完成但不给证据 → 状态停在 `reviewing`，**余额不变**，卡片显示 `need_evidence`。
- [ ] 补一张截图后点重新审核 → AI 判定 pass → 入账，余额增加。
- [ ] 证据与任务无关（随便一张图）→ 仍判 `need_evidence`，不通过。
- [ ] 不需要证据的每日任务，点完成直接入账 1 分，不要求证据。
- [ ] 绕过 UI 直接调 `api.task.complete` 且不带 evidence → 返回 `CONFLICT`，数据库无新流水。
- [ ] 模型超时/报错 → 停在 `reviewing` 并显示 `[重试]`，**绝不自动入账**。
- [ ] 撤销一次带证据的完成 → 证据保留在任务上，余额回滚。

**禁止**：不要在模型失败时降级为"自动通过"。S4 一旦有例外，等于没有 S4。

---

## W8 · 提醒（按类型 + 醒目度）

**只许改**：`src/main/scheduler/**`、`src/main/services/reminderService.ts`、`src/main/notify/**`、`src/renderer/main/features/reminder/**`

**交付**

1. `reminderService.syncForTask(taskId)`：按 `tasks.reminder_offsets_json` 生成 `reminders` 行，幂等（删未触发的旧行再建）。**必须在 W5 建任务时就能被调用**，本阶段补全实现。
2. 偏移 → 触发时刻换算：`fire_at = due_at + offset`，落在 `quietHours` 内顺延到 `08:00`。
3. `daily` 分支：按 `daily_time` + `repeat_rule` 生成当天/下一触发点的 reminder，关联当天 occurrence。
4. `reminderScheduler`：启动载入 active，`setTimeout` 到最近一条 + 30s 心跳兜底（防休眠唤醒丢失）；错过的提醒唤醒后补发**最多一条**。
5. 触发链路：写 `messages(kind='reminder')` → 广播 `message.appended` + `reminder.fired` → 按 `channels` 逐渠道派发（`inapp` 永远先发）。
6. 渠道实现：`inapp`（HUD 变色脉冲 + 会话注入 + 主窗 flashFrame）、`toast`（Electron Notification）。
7. 醒目度 `normal` / `strong`（04 §9）；`strong` 的顶部横幅组件。
8. 静默时段逻辑 + 顺延补发。
9. 任务详情里可增删偏移（"再加一个提前 3 天"）。

**验收**

- [ ] 建一个限时任务、截止 3 天后 → `reminders` 表出现 2 行（-1440、-60）。
- [ ] 建一个活动任务、5 天后发生 → 出现 2 行（-4320、-1440），-10080 那条因已过去被跳过。
- [ ] 建 `daily_time='21:00'` 的每日任务 → 今天 21:00 触发，触发后自动排明天。
- [ ] 到点会话流出现提醒条 + HUD 变色脉冲 + 系统 toast 三条同时到。
- [ ] 把系统通知权限关掉 → 应用内提醒仍正常，`fail_reason` 记录 toast 失败，不重复弹错误框。
- [ ] 22:30 到点的提醒被顺延到次日 08:00，且只补一条。
- [ ] 系统休眠 2 小时后唤醒，错过的提醒补发一次，不刷屏。
- [ ] 删除任务时其提醒级联清理；取消的提醒不再触发。
- [ ] 改截止时间后旧提醒行消失、新行生成，不出现重复触发。

**禁止**：不要在 `reminderService` 里直接 `new Notification()`，走 `notify/channels`。

---

## W8B · 外部通知渠道

**只许改**：`src/main/notify/channels/**`、`src/renderer/main/features/settings/**`

**交付**（按 02 §6.3 的 P0 → P1 执行；P2 只留接口，不做真实验收）

1. `ChannelRegistry` + `NotificationChannel` 接口（02 §6）。
2. `mailChannel`：走已连接的 Agent Mail，配置收件邮箱即用。**这是本版唯一必须真正接通的外部渠道。**
3. `webhookChannel`：可配置 URL / method / headers / body 模板，模板变量 `{{title}} {{detail}} {{offsetLabel}} {{dueAt}} {{level}}`。**最小实现即可**，用 httpbin 验证模板替换正确，不要求接任何真实推送服务。
4. 设置页：渠道列表、可用状态、配置表单（webhook 用 JSON 文本框）、`[测试]` 按钮（调 `reminder.testChannel`）。
5. 密钥走 `safeStorage`，不落 DB 明文。
6. **`webhook` 必须支持自定义 header** —— 这条现在不做会让将来接 harness/PushDeer 时改契约。

**验收**

- [ ] 未配置任何外部渠道时，提醒照常触发且**不报错**，`channels` 里 `available=false`。
- [ ] 配好邮件收件人 → 点测试 → 收到一封，正文含任务标题、偏移标签、截止时间。
- [ ] 配一个 webhook（用 `https://httpbin.org/post` 验证）→ 回显 body 里模板变量已正确替换。
- [ ] webhook 加自定义 header `Authorization: Bearer xxx` → httpbin 回显里能看到该 header。
- [ ] 邮件发送失败（如断网）→ `fail_reason` 有记录，应用内提醒不受影响。
- [ ] `safeStorage` 加密后的密钥在 DB 里是密文。

**不做**：harness 的 `/v1/notify` 联调（P3，暂缓）；QQ 官方开放平台机器人；hook 本地 QQ 客户端；逆向协议。

---

## W9 · 悬浮窗（v0.30 重做）

**只许改**：`src/shared/types/{ipc,events,channels}.ts`（仅 hud 段）、`src/preload/index.ts`（仅 hud）、
`src/main/services/hudService.ts`、`src/main/windowManager.ts`（仅 HUD 建窗）、`src/main/ipc/{guards,registry}.ts`（仅 hud）、
`src/main/db/defaultSettings.ts`（仅 hud key）、`src/renderer/hud/**`、`tests/main/hudService.test.ts`、
`tests/ipc/hudChannels.test.ts`、`tests/renderer/hudWiring.test.ts`（新增）。

**交付**（规格见 04 §5，v0.30）

1. 两态：`ball`（56×56，贴右边缘，y 自由）/ `panel`（默认 360×480，可拉伸）。
2. 首次启动贴右、距顶 1/10 屏高；位置与面板尺寸记忆，重启恢复。
3. 点球展开、面板内 ESC 收回；删掉 v0.21 的拖动实时变形与 `dock-bar`/`float-pod` 全链路。
4. 面板两页：`今天`（今日行 + 完成/打卡 + 一句话加任务）/ `设置`（背景颜色、透明度、关闭悬浮窗）。
5. `hud.background` / `hud.opacity` / `hud.size` 三个新 settings key；删 `hud.expanded` 与 `hud.setExpanded`。
6. 与 `DomainEvent` 同步、启动自取 bootstrap；多屏 & 分辨率变化后 clamp 回工作区。

**验收**

- [ ] 清掉 `hud.position`/`hud.size` 后启动：球 56×56、贴右边缘、距顶约 10%（误差 ≤ 8px）。
- [ ] 点球 → 面板；ESC → 球；两个 tab 能切换，页面只有 04 §5.3 允许的文字。
- [ ] 球可自由拖动；球拖离左右边 >48px → 变面板，面板拖到距边 ≤24px → 收球（滞回、不闪）；拖面板头部移动、拉右下角改尺寸，重启后位置与尺寸都保持。
- [ ] 设置页改颜色/透明度即时生效、重启保留；`关闭悬浮窗` 生效且主窗顶栏能再打开。
- [ ] 今天页点每日行打卡、点限时行完成，界面靠事件回流更新；被证据闸门拦时行内显示错误原文。
- [ ] 主窗勾完一个任务，HUD 的 `● N/M` 在 100ms 内更新。
- [ ] 拔掉副屏重启 / 运行中插拔屏，HUD 不留在屏幕外。
- [ ] ~~全屏自动隐藏~~（v0.17 顺延 W10，key 保留不实现）


---

## W10 · 打包

**只许改**：`electron-builder.yml`、`build/`、`package.json` scripts

**交付**：NSIS 安装包、图标、`asarUnpack: better-sqlite3`、首启动建库、卸载保留用户数据（放在 userData 不随卸载删）。

**验收**：干净 Win10/11 机器安装 → 启动无缺失 DLL → 建库成功 → 完成一次建任务全流程 → 卸载重装数据还在。

---

## W11 · 附件存储

（编号避开已有的 W10 打包。与 W2 同期开工，互不抢文件。）

**只许改**：新建 `src/main/attachments/**`、`src/main/services/attachmentService.ts`、`src/main/db/repositories/attachmentRepo.ts`、`tests/attachments/**`；另外**允许**三处小改——`src/main/db/repositories/messageRepo.ts`（把 `insertAttachment` / `listAttachments` / `attachmentsFor` / `attachToMessage` 搬到新 repo，`messageRepo` 保留同名再导出或改为 import，**`messageService` 的调用点不许改**）、`src/main/db/index.ts`（加一行 `export * as attachmentRepo`）、`src/main/index.ts`（`registerAttachmentScheme()` / `registerAttachmentProtocol()` 两处注册调用，及它们的 import 与注释——不止字面两行）。

**交付**

1. `attachmentRepo`：行级 CRUD 从 `messageRepo` 迁出来，`sha256` 查重、按 message 批量取。
2. `attachmentService.add({ name, mime, base64?, sourcePath? })`：校验 → 算 sha256 → 查重 → 落盘 `userData/attachments/YYYY/MM/<id>.<ext>` → 插行 → 返回带 `app://attach/<id>` 的 `Attachment`。
3. `attachmentService.read(id)`：给协议和 W4 用，返回 `{ bytes, mime }`；**不暴露成 IPC**。
4. `app://attach/<id>` 协议：`registerSchemesAsPrivileged` 在 ready 前、`protocol.handle` 在 ready 后；id 形状校验、查不到 404、路径只从 `rel_path` 取。
5. 上限 25 MiB、mime 白名单（png/jpeg/webp/gif/pdf），越界用 `FILE_TOO_LARGE` / `UNSUPPORTED_MIME`。
6. 测试：落盘路径形状、同文件两次 add 复用物理文件但两行两 id、超限/非白名单被拒、`read` 拿不到不存在的 id 抛 `NOT_FOUND`、`../` 之类的入参进不了路径。

**不做**：IPC handler（W2 注册 `attachment.add` 通道，preload 已声明）、渲染层接入（W3）、AI 取图（W4 调 `attachmentService.read`）、物理文件删除（v1 只增不删）。

**验收**

- [ ] 同一张图连续 add 两次 → `attachments` 两行、`rel_path` 相同、磁盘一个文件。
- [ ] 把 id 换成 `../../../etc/passwd` 调 `read` → `NOT_FOUND`，不读任何文件。
- [ ] 10 MiB 的 PDF 走 `sourcePath` 能落盘；26 MiB 的返回 `FILE_TOO_LARGE`。
- [ ] 重启应用后 `app://attach/<id>` 仍能取到图片（不是内存对象也不依赖渲染层 blob）。**这条单测覆盖不了**——协议注册时序与 `standard/secure/stream` 标志只在真 Electron 里生效，归 W10 打包验收：手点一次 `<img src="app://attach/<id>">`。

---

## 协作纪律（发给每个 AI 时必须附带这一段）

**交付报告里的"已由对方完成 / 已在契约里声明"类表述必须附 commit 号**（二轮审核揪出：v0.13 声称 `db/index.ts` 的转出"已由架构方加好"，实际从未落地）。没有 commit 号的声明按未发生处理。

1. **只改你被授权的目录**。需要别人目录里的改动，写一句需求说明交给调度方，不要自己动手。
2. **`src/shared/**` 是只读的**。缺字段就提变更单：`要加什么 / 为什么 / 影响谁`。
3. **不要为了"顺便优化"改动已完成模块**，尤其不要重命名已冻结的类型与通道。
4. **接口文档优先于你的直觉**。文档写错时提变更，不要默默按自己的做法写然后让文档过期。
5. **交付必须附一段自检结果**：跑了哪些验收项、哪几项没过、没过是什么原因。不许只说"已完成"。
6. **不许自己加界面文案**，见 04 §1。
7. 发现设计缺陷不要绕，直接报：`位置 / 现象 / 影响 / 建议`。
