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

## W7 · 完成审核（含证据闸门）（v0.37：已交付，待手点）

**交付**：`97568e1`（25 文件，+1064/−298），架构方四命令实跑 **51 文件 / 637 条**全绿，26 条要求逐条对过、越界 0。
**未完成的一步**：`kickoff/33 §8` 四条真机手点（施工方无法做 GUI 交互）。用户手点后报出结构性问题 → **`kickoff/36` 补丁（v0.38）**，`kickoff/35` 并入其中作废。

规格唯一来源：`kickoff/33-W7-完成审核与证据.md`。用户 2026-10-30 裁决：
**必须过审才计分**；证据是**文件/图片附件**；审核不通过回 `doing`，**限时/活动超期则判失败**；
**「部分完成」不算通过、不发分**；**证据不可删**（没有删除通道就不给按钮）。
v0.36 追加裁决：**`pass` 之后落库失败也一律回 `doing`**（与 `ai.review` 失败同一个兜底，`pass` 卡不加按钮）。

**只许改**：`src/shared/types/domain.ts`、`src/shared/channels.ts`、`src/shared/types/ipc.ts`、
`src/preload/index.ts`、`src/main/db/stateMachine.ts`、`src/main/ipc/{guards,registry}.ts`、
`src/renderer/main/features/tasks/**`（含新增 `reviewFlow.ts`）、
`src/renderer/main/features/chat/{useChatData,chatTypes}.ts`、
`src/renderer/main/components/TaskReviewCard.tsx`、相关样式与 `tests/`。

**交付**

1. 点完成 → **`pending_review`（待提交）** → 会话末尾出待提交卡 → 交证据 → `[提交]` → `reviewing` → `ai.review` → 按 verdict 分流（`pass` 自动 `task.complete` 计分；
   `partial`/`fail` 回 `doing` 或判 `missed`；`need_evidence` 停在 `reviewing`；请求失败回 `doing` 并显示错误原文）。`[取消]` 或停留超 10 分钟回 `doing`。
2. **审核卡接真数据**（v0.35 补）：`useChatData` 里的 fixture 任务/证据/need 计数三处全部换成 `task.get` + `attachment.get`，
   并订阅 `message.appended`（仅 `meta.kind === 'task_review'`）。不换的话卡片永远不渲染，§验收全过不了。
3. **附件通道真正接通**（v0.35 补）：`attachment.add` 此前只在 preload 声明、主进程未注册 handler；
   本单注册 `attachment.add` + 新增 `attachment.get`（只回元数据）。
4. `missed` 状态：`reviewing → missed` 唯一入口、终点状态、不计分，与 `done` 同档显示（过滤口径 `updatedAt` 当天）。
5. 每日任务不接审核（`occurrence.complete` 一行不动）。
6. 卡片动作区（v0.36 明确）：`need_evidence` 有 `[补证据]`→有证据后 `[重新审核]`，**连续 3 次后最右加弱化 `[直接标记完成（不计分）]`**；
   `pass`/`partial`/`fail` 一律无按钮。

**验收**

- [ ] **（v0.38 起流程已变，以 `kickoff/36 §11` 为准）** 限时/活动点完成 → 待提交卡 → 交证据 → `[提交]` → 判 `pass` 才加分；不给证据不可能拿到 `pass`。
- [ ] 驳回：`partial`/`fail` → 回 `doing`、分数不变；已过截止时间的驳回 → 落 `missed`（列表底部、变淡）。
- [ ] 未配置 AI key 时点完成 → 回 `doing` + 行内错误原文，任务不卡在 `reviewing`。
- [ ] 重启后审核卡仍在，且已有证据的缩略图仍能显示（证明走的是库里的数据，不是内存态）。
- [ ] ~~全屏自动隐藏~~（v0.17 顺延 W10，key 保留不实现）

**补丁 `kickoff/36`（v0.38，待发）**：手点发现三件事，都归本单。
1. **限时/活动一律要证据**。`requiresEvidence` 手动建任务时恒为 false → 所有限时任务被当"不需要证据"，
   AI 凭一句"我做完了"直接 `pass` 发分（`hardGateOf` 放行、prompt 规则 4 兜底）。改为按 type 判定，字段失效。
2. **点完成不再直接送审**。新增 `pending_review`（待提交）：点完成 → 会话末尾出待提交卡（非消息，按状态派生）→ 交材料 →
   点 `[提交]` 才转 `reviewing` 并调 `ai.review`。`[取消]` 或停留超 10 分钟自动回 `doing`（主进程扫描，不看前端计时器）。
3. **`[+]` 门控 + `[取消]`**：`[+]` 只在 `todo/doing/pending_review/reviewing` 渲染（`pass`/`missed` 卡上一个可点的东西都没有）；
   `need_evidence` 卡最左加 `[取消]`（回 `doing`、不发分）。

**补丁 `kickoff/35`** 的三处（`[+]` 门控、`tasksModel` 粘行、`TODO(W6)`）合并进 `kickoff/36`，不再单独发。


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

- [ ] 清掉 `hud.position`/`hud.size` 后启动：长条 132×40、贴右边缘、距顶约 10%（误差 ≤ 8px）；
      条内从左到右是「进度环 / `3/8` / 星期」，环的填充比例与打卡数一致。
- [ ] 点球 → 面板；ESC → 球；两个 tab 能切换，页面只有 04 §5.3 允许的文字。
- [ ] 长条可自由拖动，窗口贴着光标走（不偏、不滞后）；长条**松手时**离左右边 > 工作区宽度 1/8 → 变面板（拖动过程中不变形态）；
      面板拖出屏幕**超过自身宽度 1/3** → 收成长条并贴出屏那侧；出屏 ≤1/3 时保持原位（不推回、不收起）；
      拖面板头部移动、拉右下角改尺寸，重启后位置与尺寸都保持。
- [ ] 设置页改颜色/透明度即时生效、重启保留；`关闭悬浮窗` 生效且主窗顶栏能再打开。
- [ ] 今天页点每日行打卡；限时/活动行**没有勾选框、点了没反应**（v0.38）；每日打卡失败时行内显示错误原文。
- [ ] 主窗勾完一个任务，HUD 的 `● N/M` 在 100ms 内更新。
- [ ] 拔掉副屏重启 / 运行中插拔屏，HUD 不留在屏幕外。
- [ ] 在 HUD 设置页点「关闭悬浮窗」→ 悬浮窗消失且主窗顶栏开关同步变为关；
      点该开关**一次**即重新出现（不再需要连点两次）。
- [ ] ~~全屏自动隐藏~~（v0.17 顺延 W10，key 保留不实现）

**补丁 `kickoff/37`（v0.38，待发）**：用户手点后裁决，本单只改悬浮窗。
1. **限时/活动行不再给完成选项**（原来那条勾走 `transition('reviewing') → task.complete`，**绕过 AI 审核直接发分**，
   是"必须过审才计分"的漏口）。行保留、可点、点了没反应，不渲染勾选框。
2. **排序**：未完成区（每日 → 限时 → 活动）接已完成区（每日 → 限时 → 活动）；限时/活动按 `dueAt` 升序。
3. **完成即沉底**：主窗完成后该行变灰（`opacity .5`）落到最底，不是从列表消失。需要 HUD 首载补一次
   `task.list({ status: ['done', 'missed'] })`（`bootstrap.tasks` 只有活跃三态）。
4. **列表可滚动**：去掉 6 行截断。

---

## W10 · 打包

**只许改**：`electron-builder.yml`、`build/`、`package.json` scripts

**交付**：NSIS 安装包、图标、`asarUnpack: better-sqlite3`、首启动建库、卸载保留用户数据（放在 userData 不随卸载删）。

**验收**：干净 Win10/11 机器安装 → 启动无缺失 DLL → 建库成功 → 完成一次建任务全流程 → 卸载重装数据还在。

---

## W10b · 开机自启 + 单实例 + 悬浮窗打开主界面（v0.46 交付）

**授权目录**：`src/main/{index,windowManager,autoStart}.ts`、`src/main/ipc/{registry,guards}.ts`、`src/shared/{channels.ts,types/ipc.ts}`、`src/preload/index.ts`、`src/renderer/hud/{HudSettings,useHudData}.tsx?`、对应测试。**不许碰** `hud.css`、`renderer/main/**`、`db/**`、`hudService.ts`。

**用户五条裁决**：① 不做界面开关；② 开机只出悬浮条（132×40），主窗不弹；③ 默认就开（首次运行写注册表）；④ 单实例一并加；⑤ `打开主界面` 放 HUD 设置页第 4 项，文字固定四字。

**交付**：`autoStart.ts` 四个导出（`AUTOSTART_FLAG` / `isAutoStart` 精确匹配 / `loginItemArgs` 打包与开发两形态 / `seedAutoStart`）+ 标记文件 `autostart.seeded`（播过种后**永不再碰注册表**，用户删 Run 键也不写回）；`windowManager.showMainWindow()` 作为"叫出主窗"的唯一入口（`second-instance` 与 `app.showMain` 共用，主窗已被 `×` 关掉则重建）；单实例锁在 `whenReady` 之前，拿不到锁直接退出、不建库不建窗；新通道 `app.showMain`（WIRED 55 → 56）。

**验收**（`kickoff/46` §9，真机五条）：Run 键出现 `taskloop` → 照那条值跑只出悬浮条 → 点悬浮条进设置点 `打开主界面` 主窗出现 → 关掉主窗再点能重建 → 再启动一次只有一个进程且主窗被拉出来。

**明确不做**：自启的界面开关与状态展示、托盘图标、记住上次主窗开没开、macOS/Linux 分支、参数透传、把自启状态塞进 settings 或 bootstrap、HUD 双击手势。

**已知边界**：未打包时 Run 键指向 `node_modules\electron\dist\electron.exe` + 项目目录，挪目录/删 `node_modules` 就失效（打包后自动走 `isPackaged` 分支）；从"任务管理器 → 启动"禁用后 Windows 不删 Run 键，我们**看不见**也不纠正。

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

## W12 · 生活助手：双模式对话 + 人物卡 + 长期记忆（v0.37 定稿）

用户 2026-10-30 原话：「放在 w7 后面做吧，要像豆包那样可以进行日常对话（其实是想要一个生活小助手，能接入人物卡就更好了）」。

规格唯一来源：`kickoff/34-W12-生活助手.md`。**W7 合入后才发**——W7 会重写 `useChatData` 的数据链，本单在同一文件继续，并行必冲突。

### 已裁决（用户 2026-10-30，七问七答）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | 「人物卡」 | **c + a**：用户画像（长期记忆「我是谁」）+ 内置人设（名字 / 称呼 / 人设正文 / 语气）。表支持多张，v1 只用一张 |
| 2 | 对话形态 | **b 双模式**：聊天不抽任务卡，切到建任务模式才进 parse |
| 3 | 流式 | **呈现层逐字显现，不与模型 token 同步**（04 §3.4.2）。SSE 真流式不做，理由见下 |
| 4 | 记忆范围 | **主流产品做法**：最近 20 条原文 + 更早的摘要压缩 + 画像条目。自动提取 + 手动可改（丙） |
| 5 | 切模式的按钮 | 文字**随状态切换**：`任务模式` / `聊天模式`，放加号旁边，两种模式**配色一致**（淡蓝底）。v0.42 用户改：原「只有两个字『模式』、当前态靠底色区分」作废，见 04 §3.4.1 |
| 6 | 聊天模型 | **`glm-4.7-flashx`**（非推理、纯文本、便宜）。任务侧仍是 `glm-5.3-flash`。**不需要识图** |
| 7 | 聊天模式发图 | **不拦、不提示、不置灰**——用户原话「我发不发图片我自己不知道吗」。图片照常落库，但不进 prompt |

**为什么不做 SSE**：`glm-5.3-flash` 是推理模型，首字延迟主要花在思维链上，SSE 只改善后半段；而聊天换成非推理的 `glm-4.7-flashx` 后首字本来就快。真流式要动 `glmClient` 分帧器 + `runTurn` 边收边写 + 新增"半截消息怎么办"的失败规则，收益与成本不成比例。**留作 W12C 备选**，等这一版真跑起来看手感再定。

### 现在为什么聊不起来（实测，四条断点）

1. **渲染层根本没调 `msg.send`**：`useChatData.ts:462` 还是 `// TODO(W2)`，`send()` 只往本地数组插气泡 + 600ms 假转圈。全仓库 `src/renderer` 下 `msg.send` **0 命中**。主进程链路（W4）完整，断在最后一米。
2. **AI 读不到任何任务数据**：`buildParseRequest` 只喂 system + fewshot + 最近 6 条 + 本轮文字/图片。没有任务列表、完成记录、积分、日历。`intent` 里的 `query` 只有 schema 定义，主进程从不读它。
3. **聊天附件是假的**：`ChatInput.toAttachment()` 只造 `local-att-N` 预览对象，`msg.send` 收到的 `attachmentIds` 是假 id。
4. **输出被 JSON 锁死**：`ParseResultSchema` 是 `{reply ≤120 字, tasks ≤3}`。闲聊和抽任务共用一条管线，回复必然短、必然带卡。

### 交付（四条链，规格在 kickoff/34）

| 链 | 落点 |
|---|---|
| A 纯文本闲聊管线 | 新 `ai/pipelines/chat.ts` + `AiProvider.chatText` + `prompts/chat.system.md`（03 §4.3） |
| B 双模式入口 | `msg.send` 加 `mode`（02 §3.3），渲染层按钮给值，主进程不猜（04 §3.4.1） |
| C 逐字显现 | 渲染层 typewriter 40/80 字每秒（04 §3.4.2），不动请求协议 |
| D 数据层 | 迁移 `003_chat.sql`：`personas` / `memories` / `chat_state`（01 §2.8~2.10）+ 六条 IPC（02 §3.8） |
| E 记忆提取 | `ai/pipelines/memory.ts` + `prompts/memory.system.md`（03 §4.4），异步、失败静默 |

**验收**：切到聊天模式问「我今天还有什么事」，回答里的任务条数/积分与右栏一致；说「帮我记个明天三点交作业」它如实说这个模式不能建任务；切到建任务模式说同一句，出草稿卡；关掉重开，聊过的内容还在、记忆还在。

---

## W12B · 设置面板：人物卡 + 记忆（v0.37 立项，**v0.44 已交付**）

**为什么单独一单**：主窗目前**没有设置页**（`src/renderer/main` 下只有 tasks/chat/points/calendar/RightSplit，唯一的设置是 HUD 那 43 行的 `hud/HudSettings.tsx`，只管悬浮窗外观）。而 W12 的「手动改记忆」（第 4 条裁决的丙方案）必须有地方改，否则丙退化成甲。

**范围**：顶栏一个设置入口 → 抽屉面板，三块：

1. 人物卡：名字 / 怎么称呼我 / 人设正文（多行，≤800 字）/ 语气三选一。
2. 记忆：列表（内容 + 来源角标 `自动` / `手动`）、就地编辑、单条删除、手动新增。
3. AI：key 是否已配置（只读状态，不给输入框）、两个模型名（任务模型 / 聊天模型）。

**代价**：这是本项目第一个真正的表单页，会带来输入校验、脏值离开提醒、保存反馈三套通用逻辑。**不做进 W12，是为了让 W12 能一次跑通对话闭环**，而不是被表单拖住。

**交付（v0.44，`1a5ede0`，`kickoff/44`）**：形态定为右侧抽屉 420px + 遮罩；人物卡显式 `[保存]`（脏值才亮，只提交变化字段）；记忆行内编辑 + 每行删除 + 底部新增；语气 `温柔/直率/活泼`。新增 `ai.keyStatus`（不联网，只为显示一行状态）。**三处主动放弃**：key 输入框（`writeKey()` 按 03 §9.7 不许注册成 IPC）、改模型名（改错会让建任务与审核全线失败，且无回滚入口）、清空全部记忆（02 §3.8 明令禁止）。规格见 04 §10，文案白名单见 04 §1.3。

---

## W13 · 零花钱：汇率浮动 + 支出记账（v0.45，**已交付**）

**为什么立这一单**：用户 2026-10-31 原话「我这个积分是用来控制我零花钱的使用的，每个月大概有 500，所以需要一个汇率，还需要一个记账的地方，可以把我花的积分记下来，并且从我获得的积分里面扣」。此前积分只是一个分数，拿它管钱差三样东西：**能换成钱的汇率**（且应该随表现浮动）、**一个记账入口**、**记错能改**。

**已裁决（用户八条 + 三条写死，规格见 `kickoff/45`）**

| # | 裁决 |
|---|---|
| 1 | 基准 **500 积分 = 500 元**（1 积分 = 1 元），作为 100% 基准 |
| 2 | 记账填**金额（元）**，系统按当期汇率自动换算成积分扣掉 |
| 3 | **允许扣成负数**，余额为负时 ③ 的大数字变红，不拦截 |
| 4 | 入口是 **④ 的第 5 个标签「支出」**，不与「明细」合并 |
| 5 | 汇率由 AI 按任务完成情况评估，区间 **±15%（0.85 ~ 1.15）** |
| 6 | 完成得好就**升值**（1 分换更多钱），懈怠则贬值 |
| 7 | **每周一自动**评估一次，本周内不变 |
| 8 | AI 失败**沿用上期汇率**，不许回落 1.0 抹掉升幅 |

写死的三条：月预算 500 元固定（不做可改）、记错可撤销（沿用冲销机制，不真删流水）、当前汇率显示在支出页顶部。

**交付（v0.45，`kickoff/45`）**：迁移 `004_spend`（`point_ledger` 加 `amount_cents` / `fx_rate` 两列 + 新表 `fx_rates`）；`points.spend` / `spendUndo` / `spendMonth` 三条通道（WIRED **52 → 55**）；`fxService.currentRate` / `ensureWeek` + `fxSweeper`（30 分钟轮询、启动立即跑一次）+ `ai/pipelines/fx.ts` + `prompts/fx.system.md`；渲染层第 5 个标签 `SpendView`（顶部汇率与已花、本月支出列表、底部记账行）。公式见 02 §5.7，表结构见 01 §2.4 / §2.11，文案白名单见 04 §1.4，提示词契约见 03 §4.5。基线 59/728 → **62 / 751**。

**明确不做**：预算可改、周预算、消费分类/标签、支出图表、导出、跨月预算结转、**聊天里说一句自动记账**（要另开一单动解析管线）、多币种、改历史流水的金额、删除流水（只撤销）、改汇率的手动入口。

**已知小账**：`spend()` 里 `delta === 0` 是走不到的防御分支（最小 1 分 ÷ 1.15 取两位后仍为 0.01）；`fxRepo.weekSnapshot` 与支出统计同放 `fxRepo` 而非 `statRepo`，属实现方放置偏好，不影响口径。

---

## W12C · SSE 真流式（备选，不建议现在做）

见上文「为什么不做 SSE」。触发条件：① 换成非推理模型后仍觉得「等太久才出字」；② 长回复（>800 字）成为常态。两个条件都不成立就别做。


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
