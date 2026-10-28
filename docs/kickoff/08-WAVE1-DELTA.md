# 波次 1 · 开工词补充（v0.5 → v0.7 差异）

> **为什么有这份文档**：`01`–`06` 六份模块开工词写于契约 v0.5。之后契约经历了两次变更，
> 而开工词没有逐份重写（改 6 份会漂移 6 次）。下面每条都是**硬变更**：
> 与你手上的模块开工词冲突时**以本文为准**，本文没提到的以 `docs/` 为准。
>
> **契约冻结**：git tag `contract-v0.10`。你读的 `docs/` 应为该 tag 的内容，
> 若不是（例如发现文档比你开工词还旧），停下来报告，不要按旧版实现。
>
> **架构方自己维护的文件**（不在任何施工会话的授权清单里，因此它们变化不算越界）：
> `src/shared/**`、`src/main/windowManager.ts`、`docs/**`、`package.json` 的 `scripts` 段、
> `scripts/**`、`tsconfig*.json`。施工方看到这些文件变了，**不要改回去、不要报越界**。

---

## 全局（6 个模块都受影响，逐条核对你有没有踩）

### D1 · 积分是小数，不是整数

这是最容易踩的一条，因为**肉眼看不出来**：

| 位置 | 值 |
|---|---|
| DDL 字段类型 | `tasks.points_planned` / `tasks.points_awarded` / `task_occurrences.points_awarded` / `point_ledger.delta` / `daily_stats.points` 全部 **`REAL`**，不是 `INTEGER` |
| 精度收敛 | `roundPoints(v) = Math.round(v * 100) / 100`。**对积分值的取整只允许这一处**；别处若出现 `Math.round`/`toFixed`/`Math.floor`，必须同时满足"不产出积分值"且"注释写明用途"（目前只有日期整除与逾期天数两类），否则算违规 |
| 公式里不再取整 | `computePlannedPoints` 返回 `clamp(roundPoints(cfg.difficultyBase[d]), 1, 100)`，不 `Math.round` 成整数 |
| `RUBRIC_VERSION` | `'v0.7'`（v0.9 契约起。若你读到 `v0.6-b`，说明看的是旧文档） |

典型值（**契约 v0.9 之后重算过，旧的按分钟加权那套已废**，以 `02-CONTRACTS.md` §5.2 为准）：

```
应得分只看难度，时长不进公式：
trivial → 5      easy → 10      medium → 20     hard → 35      epic → 50
estimateMin 传什么都不影响结果（它只用于 AI 判难度、排提醒、算逾期）

限时（planned = 20）：
  提前 96h 且达标        → 20 × 1.2 = 24
  提前 30h 且达标        → 20 × 1.1 = 22
  卡点完成               → 20
  逾期 3 天              → 20 − 3×2 = 14
  提前 96h 且超预期      → 20 × 1.2 × 1.15 = 27.6

活动（planned = 20，不看 quality）：
  超预期 → 24    达标 → 20    不佳 → 17

medium 质量 partial（无限时/活动系数）→ 20 × 0.6 = 12
```

**UI 显示统一走 `fmtPoints`**（`04-UI-SPEC.md` §4③；§6 是设计 token 表，别去那儿找）：最多 2 位小数、去掉尾零。
`20` → `20`，`27.6` → `27.6`，`48.3` → `48.3`，`12` → `12`。不要写 `20.00`。

**累加陷阱**：余额是 `SUM(delta)`。如果每笔都是 `5.750000000000001`，几十笔后会出现
`319.99999999999994`。所以写入前必须过 `roundPoints`，不能只靠显示层 `toFixed`。

### D2 · `AppSettings` 是封闭接口，`setSetting` 是泛型

`src/shared/types/ipc.ts` 已有（W0 已实现，你直接 import，**不要重定义**）：

```ts
export interface AppSettings {
  'ai.provider': { name: 'zhipu'; model: string }
  'hud.mode': HudMode
  'hud.displayId': number | null
  'hud.position': { x: number | null; y: number | null }
  'hud.autoHideFullscreen': boolean
  'points.difficultyBase': Record<Difficulty, number>
  'points.dailyBase': number
  'points.streakBonus': { days: number; bonus: number }[]
  'points.dailyCap': number | null
  'reminder.quietHours': { from: string; to: string }
  'reminder.channels': NotifyChannel[]
  'channel.mail': { to: string } | null
  'channel.webhook': WebhookConfig | null
  'app.theme': 'light' | 'dark'
}
export type PublicSettings = AppSettings
```

三条约束：

- **14 个 key**。`ai.apiKey` 不在其中——它存 `safeStorage`，不入 settings 表。不要补。
- `app.setSetting` 是泛型 `{ key: K; value: AppSettings[K] }`，**不许退回 `{ key: string; value: unknown }`**。
- 新增 key 必须先改 `AppSettings` + `01-DATA-MODEL.md` §2.7，两边同时改，然后提变更单——**不要自己加**。

### D3 · 完成审核必须带证据

- `tasks` 有 `requires_evidence`（0/1）与 `evidence_json` 两个字段，建表不能漏。
- `task.complete` 入参是 `{ id: string; quality: Quality; evidence?: Evidence[] }`——是 `Evidence[]`，不是 `string[]`（v0.8 起 `Evidence` 是 `{kind:'text'}|{kind:'attachment'}` 的联合），以 02 §3.2 为准。
- **硬校验在 service 层**：`requiresEvidence === true` 且 `evidence` 为空 → **停在 `reviewing`、不入账**，
  返回 `AppError{ code: 'EVIDENCE_REQUIRED' }`。不能只在 UI 拦——绕过界面直接调 IPC 也拿不到分。
- 连续 3 次补不上证据，UI 给一个 `[直接标记完成（不计分）]` 出口。这是防死锁，点了就是 0 分。
- **不存在"先入账再追问"**。v0.4 时期有过这个口子，已删除。有例外就等于没有证据要求。

### D4 · 交付前自己跑这两条

```
npm run typecheck
npm run lint
npm test
```

三条都 exit 0 才算交付。只写"我认为没问题"不算。

`npm test` 走 `scripts/test.mjs`（用 Electron 内置 node 跑 vitest，绕开 better-sqlite3 的 ABI 差异），不是裸的 `vitest run`。`typecheck` 现在有三段，第三段 `tsconfig.test.json` 专门检查 `tests/`——**此前 tests 从未被 tsc 检查过**，这是 v0.9 之后补的。

---

## 分模块补充

### W1 · 数据层

1. **授权目录增加 `tests/shared/**`**（原开工词没有）。
2. **新增交付项**：`tests/shared/rubric.test.ts`。按 `02 §5.2` 示例表逐行断言六组
   `computePlannedPoints` + `computeAwardedPoints` 的质量系数与逾期扣分。
   **只测不改**：`rubric.ts` 若与 02 不一致，报告，不要自行修正。
   **`vitest@2.1.8` 已由调度方装好**，你不要跑 `npm i`。`"test": "node scripts/test.mjs"` 也已由架构方配好，**你不用再加**。
3. **`settingRepo` 的读取必须返回 `AppSettings` 全量**：DB 里只存用户改过的 key，
   读出时用 `DEFAULT_SETTINGS` 合并补齐。渲染层不处理 `undefined`——缺 key 是你的 bug。
4. **settings 的 value 是 JSON 字符串**：`JSON.parse` 失败要抛错，**不许静默返回默认值**。
   否则用户配错了 webhook 永远收不到通知，而且没有任何线索。
5. `occurrence.points_awarded` 是 `REAL`——每日任务单日分值可能是 `1`（整数形态但类型仍是 REAL），
   不要为了"看起来整齐"改成 INTEGER。

### W2 · IPC 与事件总线

1. `app.setSetting` 通道按泛型签名暴露（`02 §4` 有 preload 的写法）。
2. `task.complete` handler 把 `evidence` 透传给 service；`EVIDENCE_REQUIRED` 走 `Err` 返回，
   **不要抛异常**——渲染层拿到 `ok:false` 才好显示"请补充证据"。
3. `app.getBootstrap` 的 `settings` 字段类型是 `PublicSettings`（= `AppSettings` 全量，
   由 W1 的 `settingRepo` 合并默认值保证）。
4. 你开工词里"handler 先返回假数据 + `// TODO(W1)`"的规则仍然有效，但**假数据的类型必须用
   `AppSettings`**，不能随手写 `{}`——否则 W1 落地后类型对不上。

### W3 · 会话 UI

1. **所有积分显示走 `fmtPoints`**。这是 v0.6 之后最容易忘的一处：`+23` 对，`+23.00` 错。
2. **审核卡片必须有证据入口**：`requiresEvidence === true` 的任务，完成按钮旁边是
   "添加证据"（可粘贴文字或选图片），不是直接"完成"。
3. 提交证据后任务停在 `reviewing`，卡片显示"待确认"。**不要乐观地先显示已完成**——
   证据不通过还会退回来。
4. 草稿卡片的"分值"是 `pointsPlanned`，**必须按 type 分派**：`deadline` / `event` 用
   `computePlannedPoints(difficulty)`（v0.9 起没有第二个参数，时长不进公式）；`daily` 用
   `settings['points.dailyBase']`（默认 1）。每日任务显示"每天 1 分"才有意义，显示 `20` 是错的。
   `points.preview` 的入参带 `type`，它会自己分派；本地算时也要照此分派。
   **`pointsPlanned` 字段本身也必须按这个口径填**——W5 确认草稿时直接写库，
   显示 1 却存 20 会让每日任务变成每天 20 分。

### W4 · AI 接入

1. `ParseResult` 的每个 task 必须含 `requires_evidence: boolean`。判定标准写进 prompt：
   写文档/交报告/写代码 = `true`；跑步/背单词/喝水 = `false`。
2. `ReviewResult.verdict` 增加 `'need_evidence'`：证据不足时返回它，业务层据此停在 `reviewing`。
   **不要返回 `pass` 再让业务层去猜**。
3. 模型**不给分**。只给 `difficulty` 和 `estimate_min`。prompt 里不许出现"给 20 分"这类示例——
   会被照抄。

### W6B · 日历 UI

1. 红点数据只由 `calendar.dayIndex(year, month)` **一次**给全，**不许**为 30 个格子各发一次请求
   （验收会用 DevTools 数请求次数）。
2. 当日条目里的分值用 `fmtPoints`。
3. 该日任务全部完成时红点变空心圈——这是已定的规则，不是可选项。

### W9 · 悬浮 UI

1. **你开工词里的 `300×32` 是占位尺寸**，最终形态是 `04-UI-SPEC.md` §5.2 的全宽贴边条
   （`x = 8, y = 0, w = screen.width - 16`）。本轮先按占位交付即可，
   **但不要反过来去改 04 文档**——04 是最终形态，W0 的 300×32 才是占位。
   这个方向搞反过一次，W9 会去改设计规格来迁就现有代码。
2. 积分显示用 `fmtPoints`，不同形态下字号不同但格式一致。
3. 悬浮条上的任务状态点与主窗必须同源（订阅 `DomainEvent`），不许自己轮询。

---

## v0.11 追补（2026-10-28 二轮审核后）

以下五条是二次审核在 `0b92cbc` / `97c4a94` 上查出来的，属于**口径缺陷**，不是风格问题。都已经写进契约，施工方按契约改，不要按"以前就是这么写的"改。

1. **默认难度是 `medium`，不是 `easy`。** `01 §2.1` 的 `DEFAULT 'easy'` 只是 SQL 兜底。`easy` 对 `event` 非法（`ALLOWED_DIFFICULTIES.event` 没有它），`task.createManual({type:'event'})` 会落出一个下拉框里根本不存在的难度档，还按 10 分入库。
2. **草稿分值必须用完整 `PointsConfig` 算。** `computePlannedPoints(d, cfg)` 省掉 `cfg` 就落回 `DEFAULT_CONFIG`；渲染层现在传的是 `dailyBase: number` 加写死的 `const DAILY_BASE = 1`。用户改过 `points.difficultyBase` 之后，卡面 +35 / 落库 +30。
3. **`task.transition({to:'done'})` 一律 `CONFLICT`**，不再有"直接标记完成"的旁路。「不计分」出口改为 `task.complete({ noPoints: true })`：写 `completed_at`、不写 ledger、`entry` 返回 `null`。
4. **`task.update` 改难度必须同事务重算 `points_planned`。** `TaskPatch` 有 `difficulty`，而 `updateTask` 只写 patch，改完难度应得分还是旧的，完成时按旧值发分。
5. **`TaskDraft.dueHint` 读侧要校验形状。** 正则 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/` 不匹配就当空串，不许直接 `new Date` —— `'10-30 18:00'` 会被解析成 **2001-10-30**，而且不报错。

另外两条文案纪律：

- `04 §1` 现在有错误消息登记表（§1.1 可直接渲染 / §1.2 只进日志）。新增 `appError` 要同时加行。
- `assertDay` 的 `label` 默认 `'day'`、调用方传 `'from'`/`'to'`，渲染出来是「from 必须是 YYYY-MM-DD 格式的本地日期」。改成中文。

### v0.11.1 补丁（两条，都在 W1 的复核问题里）

- **daily 的 `points_planned` 只有一个来源**：`createTask({type:'daily', pointsPlanned:99})` 必须**忽略**这个值、写 `cfg.dailyBase`。每日任务的应得分是定义出来的，`points_awarded` 也从不读它（走 `computeDailyPoints`）。`< 1` 的入参校验照旧，忽略只针对"合法但不用"。
- **改类型的语义还没定，别自己发明**：`TaskPatch` 没有 `type`（04 §3.2 说类型可就地改），归位/清字段/重置提醒/补 occurrence 四件事牵一发动全身，W5 开工前由架构方写进 02 §3.2。在那之前 `task.update` 收到 `type` 就当没有这个字段。

### v0.11.2（两条归属决定，2026-10-28）

- **附件存储单开一条 W11**（见 05 的授权目录与验收）。`attachment:add` 通道、`Api.attachment`、preload 已在契约里声明；W2 只注册 handler，W11 只写 `attachmentService` / `attachmentRepo` / `app://attach` 协议，两边不抢文件。渲染层在 W3 接入前继续用假附件。
- **落库后不可改类型。** `TaskPatch` 不加 `type`。04 §3.2 的"类型可就地改"只指草稿卡片（渲染层状态，已实现）；建错类型走 `task.remove` + 重建。理由：改类型要连带难度归位、清字段、重排 `reminders` 行、补 occurrence，而提醒重排要等 W8。

### v0.12（W2 开工前，2026-10-28）

W2 的开工词写在波次 1 之前，当时假设"W1 还没落地、handler 先返假数据"。W1 已收工，那一版**作废**，按 05 的 W2 段执行。以下四条是写开工词时在代码里核出来的。

1. **52 条通道只有 25 条现在能接。** 其余缺 service 函数或整条线未开工（`task.complete`、`task.promoteDraft`、`occurrence.complete/undo/skip`、`msg.send/retry`、`ai.*`、`reminder.*`、`channel.*`、`hud.*`、`attachment.add`）。未接的**一律不注册**，不放假 handler。归属表见 05 W2 段。
2. **`occurrence.today` / `listByRange` 会写库**（内部 `ensureRange`），必须广播 `occurrence.created`；`app.getBootstrap` 例外，不广播。
3. **`Bootstrap.channels` 在 W9 前恒为 `[]`**，不许返回假的可用性。`04 §1.1` 新增「请求参数格式不正确」（IPC 入参形状校验）、`04 §1.2` 新增「未知错误」（`UNKNOWN` 兜底）。
4. **`PENDING_CONFIG` 的 `TODO(W2)` 改挂 W5。** W2 不碰渲染层，草稿分值接 `bootstrap.settings` 是 W5 接线时的事。在那之前它只能是 `DEFAULT_CONFIG`。
5. **`reminder.cancel` / `snooze` 是写操作，但 `DomainEvent` 里没有对应事件类型**（只有 `reminder.fired` / `failed`）。§3.8 要求"任何写操作必须至少广播一条事件"，所以 `reminder.*` 整块划给 W8，由 W8 一并补 `reminder.updated`。本轮不提前造一个用不上的事件类型。
6. `04 §1.1` 另加「只允许打开 http/https 链接」——`app.openExternal` 拒绝非 http(s) 时要用，原先没有登记过。

### v0.13（W11 交付后，2026-10-28）

W11 报了七条，其中三条是我契约写错了，一条是我的任务书写错了函数名：

1. **`Content-Disposition: default` 是无效 token。** RFC 6266/2183 只认 `inline` / `attachment`，Chromium 直接忽略。改为：PDF 发 `inline`，图片**不发这个头**。
2. **去重键改成 `(sha256, mime)`。** 只看 sha 时，同一份字节声明成两种 mime 会复用第一次的扩展名（`.png`）而新行记第二种 mime。多存一个文件换掉一个说不清的例外。
3. **新增 `IO_ERROR` 码。** 落盘/读盘失败原先只能落 `UNKNOWN`，会被当成程序缺陷；借 `DB_ERROR` 又误导排查方向。`04 §1.1` 登记「附件写入磁盘失败」「附件读取失败」。
4. **任务书里的 `attachmentById` 在 `messageRepo` 里根本不存在**（实际是 `insertAttachment` / `listAttachments` / `attachmentsFor` / `attachToMessage`）。W11 按现有代码迁是对的，另外补的 `attachmentById` 保留。
5. `db/index.ts` 加 `export * as attachmentRepo`，与其余六个 repo 口径一致。**更正（二轮审核揪出）：上一会话声称"已加好"但从未落地**——W11 交付时该行不存在，各调用点一直是直接 import 仓库文件。已在审核整改中补上。
6. **`width` / `height` v1 留 `null`**，不引入图片解码依赖；UI 不要靠尺寸占位。
7. `read()` 的 id 形状不合法与查不到行一样返回 `NOT_FOUND`，不在读盘前区分两种失败。

另登记两条此前漏掉的文案（W11 实现里已经在用）：`INVALID_INPUT`「附件内容为空」「附件存放路径非法」、`FILE_TOO_LARGE`「附件超过 {N} MiB 上限」。

### v0.14（W5 开工前，2026-10-28）

三轮收工审核 PASS 后准备开 W5，写开工词时在代码与文档里核出两条归属矛盾，由架构方裁决如下：

1. **`task.promoteDraft` 归属改判 W6 → W5。** 05 W2 归属表与 `registry.ts` 原把它随"完成事务"成簇标给 W6，但 W6 的授权目录不含 `taskService.ts`（promoteDraft 的业务实现只能写在 W5 的授权文件里），且依赖链 W1→W5→W6 要求晋升先行。已同步：05 W2 归属表（W6 剩 4 条、新增 W5 行）、`registry.ts` 的 `NotWiredOwner` 类型与 owner 标签、`tests/ipc/registry.test.ts` 的 owner 白名单与归属抽查。**通道仍在 NOT_WIRED（26 条不变）**，注册与 guard 随 W5 授权完成。
2. **提醒 sync 顺延 W8。** 05 W5 段原交付 3 写"落库后立刻调 `syncForTask`、不能等到 W8"，与 v0.12 后的三处登记（05 W2 已知缺口、registry 注释、STATE 缺口表）矛盾。裁决：W5 不实现、不调用、渲染层不拼；05 W5 交付 3 改写为"写操作广播"要求，验收 6（改截止时间后 reminders 跟变）顺延 W8 验收，验收 1 的 HUD 部分顺延 W9。
3. **重复确认幂等补定**：同一 draft 第二次 promoteDraft（含绕过 UI 直调通道）返回已生成的原 Task，不重复落库、不报错。02 §3.2 尚未回填，W5 交付报告会提醒。
4. **W5 授权扩展**（先例同 W11 的小改豁免）：`chat/**` 仅限两处接线（PENDING_CONFIG 接真配置、确认按钮调 promoteDraft）、`registry.ts` 仅 promoteDraft 一条注册、`scripts/seed-dev-draft.mjs` 开发造数。超出即越界。
5. W5 开工词：`kickoff/09-W5-草稿转任务.md`。

### v0.15（W5 交付 `025849c` 审阅后，2026-10-28）

W5 交付报告上报 5 项，架构方裁决与落盘：

1. **幂等回填 02 §3.2**：`task.promoteDraft` 表行补"同一 draft 重复确认返回已生成的原 Task（幂等），不重复落库"。v0.14.4 的补定正式入契约。
2. **`listDailyActive` 排除子任务（真缺陷修复）**：原 SQL 无 `parent_id IS NULL`，daily 父任务的同类型子任务会被 `ensureRange` 各自生成 occurrence、污染 streak。已修 + 防回归测试（occurrence.test.ts：子任务 count=0、总数恒 7）。W5 的"子步骤落 `deadline`（due_at 恒 NULL）"绕法保留作双保险。
3. **`promoteDraft` 的 patch 改为创建侧形状 `TaskCreatePatch`**（`TaskPatch` 全字段 + 可选 `type`）：draft 尚未落库，"落库后不可改类型"约束的是 update 链路；确认本质是创建。规则写入 02 §3.2：按新 type 落库 + `pointsPlanned` 按新 type 口径重算 + due 字段按 type 映射；非法 type×difficulty 照旧只拒不归位（渲染层 `applyDraftPatch` 已 snapDifficulty）；落库后依旧不可改。**实现打通归 W5 补丁**（guards.ts 的 patch schema + taskService 传 type，均在 W5 授权内）。此裁决解决 04 §3.2"草稿卡可就地改 type"与确认链路的断路。
4. **两处授权外小改准予备案**（W11 先例）：`src/renderer/main/index.tsx`（右栏布局挂载）、`src/renderer/main/api.d.ts`（`window.api` 全局声明——渲染层此前无 IPC 类型入口，属基础设施缺口）。
5. W5 三条语义取舍认可：每日勾选框视觉先行（`occurrence.complete` 归 W6）、步骤勾选走 todo↔doing、提醒偏移只读（编辑入口归 W8）。

### v0.15.1（W5 补丁 `32eb447` 审阅后，2026-10-28）

1. **shared 触碰准予备案（架构方责任，非承包方越界）**：W5 补丁按 v0.15 把已定名的 `TaskCreatePatch` 落进 `src/shared/types/domain.ts` 与 `ipc.ts`（promoteDraft 入参类型）。`TaskCreatePatch` 这个名字是架构方在 02 §3.2 定的，契约类型落码必然要动 shared——开工词只写了"guards + taskService"，漏了这处授权，算架构方口径不全。**语义零变更**：纯新增类型 + 入参引用替换；`task.update` 的 guard 仍用 `taskPatchSchema`、type 照旧被剥（测试有断言）。此后审核对 `025849c..HEAD` 内这两处 shared 改动不算越界。
2. **脏分值口径确认**：类型被 patch 改过时 `draft.pointsPlanned` 是按原类型算的脏值（daily→deadline 时它 = dailyBase 的 1 分），必须按落库难度 × 完整 `PointsConfig` 重算；deadline→daily 时原 dueHint 不得泄进 `due_at`。W5 实现与测试均符合。
3. 基线复核一致：typecheck / lint / build 零错，22 文件 / 265 条全绿（净增 3：listDailyActive 防回归 +1、本次新增 3、重写 1）。

### v0.15.2（W5 审核两项 P2 处置，2026-10-28）

W5 收工复审 PASS（无 P0/P1，2 项 P2），处置如下：

1. **02 §2 补 `TaskCreatePatch` 条目（架构方文档欠账）**：代码块里此前只有 `TaskPatch`，按 §2"源码契约"判据机器比对会红。已补接口定义（字段名/类型与 `domain.ts` 一致，注释注明只用于 promoteDraft、update 链路红线不变）。
2. **幂等路径零广播（W5 补丁 `a8ebb93`）**：`promoteDraft` 内部返 `{ task, created }`（IPC 仍返 `Task`，契约不变），handler 在 `created=false` 时零广播——没有行被创建就不发 `created` 类事件。幂等用例补"第二次调用 events 为空"断言，新增 internal 形状用例；基线 22 文件 / 266 条全绿。
3. 保留项：幂等路径仍读一次 `listRangeRaw`（只读无副作用），不为此移动差集取样的职责边界。

### v0.16（W6 / W6B 并行开工前，2026-10-28）

1. **并行结论**：W6 ∥ W6B 是设计好的组合，现状进一步简化——`calendar.dayIndex / dayDetail` 的 handler 与查询 W1/W2 已交，W6B 实际是**纯渲染层**，与 W6 零文件重叠。W9 也可与 W6 并行（05 已写），但属第三条线；W4 条件并行（需先过 03 §6 真机验证）；**W8 不可与 W6 并行**——`pointsService` 与 `reminderService` 都要改 `taskService`，05 点名的冲突高发区；W7 硬依赖 W6。
2. **W6 授权扩展**：05 原只授权 `pointsService` + rubric（只读）+ points UI，但完成事务必须写 `taskService`（`completed_at` + `points_awarded` + ledger 同事务）、occurrence 三通道必须写 `occurrenceService`。扩为：taskService 仅 `completeTask/undoCompletion`、occurrenceService 仅 `complete/undo/skip`、registry+guards 仅四条通道、tasks UI 仅确认条接线。
3. **W6B 授权收缩**：原写的 `src/main/ipc/handlers/calendar.ts` 不存在（registry 单片文件），且 calendar 两通道已接通——改为纯渲染层 + `index.tsx` 仅挂载。
4. **W6B→W6 交接点**：浮层点行派发 `window CustomEvent('taskloop:focus-task', {detail:{id}})`，W6 在 TasksPanel 监听（授权内小改）；W6 未接通不阻塞 W6B 验收。
5. 开工词：`kickoff/11-W6-积分.md`、`kickoff/12-W6B-日历.md`。

### v0.17（W9 开工前，2026-10-28）

1. **W9 时序修正（覆盖 v0.16 第 1 条里"W9 可并行"的措辞）**：W9 文件面确实独立，但功能验收依赖 W6——验收 1「主窗勾完任务，悬浮条 100ms 内更新」要 `task.complete` / `occurrence.complete` 与 `points.changed`，W6 未合入时四条通道仍在 NOT_WIRED，只能靠假数据"通过"。且三线同改 `registry.ts`（W6 四条 / W9 五条）、`guards.ts`、`index.tsx` 必撞。**裁决：W9 排在 W6 合入之后开工**，不并行。
2. **05 W9 授权路径修正**：原写 `src/main/windows/hudWindow.ts`，该文件与 `windows/` 目录都不存在，HUD 窗体在 `src/main/windowManager.ts`。授权改为 windowManager.ts（仅 HUD 部分，`createMainWindow` 零改动），并补 `registry.ts` / `guards.ts`（5 条 hud）、`preload/index.ts`（`hud.getState` 返回形状）、新建 `src/renderer/main/components/AppHeader.tsx` 与 `index.tsx` 挂顶栏。
3. **新增 settings key `hud.expanded`**（`{ 'dock-bar': boolean; 'float-pod': boolean }`）：05 W9 验收 2 要求"切换模式后位置与展开态各自记忆，重启保持"，而原有四个 `hud.*` key 没有存展开态的位置。同步改 01 §2.7、02 §3.0 `AppSettings`、`defaultSettings.ts`（14 → 15 key）、`settings.test.ts` 两处计数。
4. **`hud.getState` 返回加 `visible`**：顶栏开关需要初态，原返回 `{mode, expanded, displayId}` 无法得知 HUD 是否可见。纯新增字段，向后兼容；02 §3.7b 表与 `ipc.ts` / `preload` 同步。
5. **`hud.setExpanded` 语义扩为两模式通用**：02 原注"dock-bar 展开/收起"，但 float-pod 从 56×56 到 360×480 同样必须由主进程 `setBounds`。入参不变，仅改说明。
6. **验收 4「全屏自动隐藏」降级顺延 W10**：纯 Electron 无原生依赖时无法可靠检测外部全屏（`isFullScreen()` 只对自己窗口；`bounds` vs `workArea` 只在任务栏自动隐藏场景有信号，borderless 全屏不触发）。本轮只做手动隐藏，`hud.autoHideFullscreen` key 保留标"未实现"，**明确禁止写永远为 false 的假检测**；W10 真机评估是否引入原生模块。
7. **HUD 快速加任务改走 `task.createManual`**：04 §5.6 原写 `msg.send`，但 `msg.send` 归 W4 未接。W4 之前直建 `deadline / medium / 无 due_at`，W4 接上后升级为 AI 解析（04 §5.6 已注）。
8. **不新增 `app.focusMain` 通道**：04 §5.2 图里的"最近待办标题 →"不实现——04 §5.6 的交互边界是权威条款，其中未列"跳转主窗"，为它开一条新通道不划算。HUD 只显示标题，不做跳转，也不放空按钮。
9. **杂项修正**：`registry.ts` 里 `channels: []` 的注释原写"W9 落地前恒为空"，实为 W8（通知渠道），已改。
10. 开工词：`kickoff/13-W9-悬浮窗.md`。

### v0.18（W6 / W6B 交付审阅后，2026-10-28）

W6 `f15ba01`、W6B `949747e` 双双合入，基线复核 **27 文件 / 341 条全绿**（typecheck / lint / build 零错）。W6B 报的四条处置：

1. **文案登记补行（P2-1，成立）**：04 §1 原本没有日历相关的固定文案出处，W6B 用的月份标题、星期列头、浮层标题、行尾分值确实无登记。已在 §1「状态中文名」后新增「显示格式（已登记）」表，收五条（含类型标签与 §4① 同源），并重申格式串外面不许包解释性文字。
2. **空态口径确认（P2-2，按 W6B 取舍定）**：只有 `total > 0` 的日期可点（与 05 验收一致），`dayDetail` 返回空时保留浮层标题、列表区留白 + 40px 最小高度，不造"暂无任务"文案。已写进 04 §4②。
3. **分值语义（P3，按原值显示是对的）**：`dayDetail` 已完成给 `points_awarded`、未完成给 `points_planned`，两者可能因质量/效率系数不等；渲染层照原值显示、不重算、不标记。要区分需新增登记文案，本轮不做。已写进 04 §4②。
4. **`toLocalDay` 三处重复实现（P2-3，认可但本轮不动）**：主进程 `db/localDay.ts`、`features/tasks/tasksModel.ts`、`features/calendar/calendarModel.ts` 各有一份同口径实现（都用 `getFullYear/getMonth/getDate`，都没用 `toISOString`）。**裁决：登记为待清理项，等 W9 收工后提到 `src/shared`**——理由：现在动 shared 会与 W9 的窗口/时间计算改动交叉，且三份当前口径一致、无 bug，不是正确性问题。
5. **W6B 的 `focus-task` 交接点已验通**：W6 侧有 `features/tasks/focusTask.ts` + `useTasksData` 监听 + `scrollIntoView` + 1.2s 高亮，04 §4② 的"点行滚到并高亮"整条链路成立。
6. **并行提交纪律执行到位**：W6B 用显式 `git add` 提交 6 个文件，W6 的 `<PointsPanel />` 与 `<CalendarPanel />` 在 `index.tsx` 里并列共存，没有互相冲掉。

### v0.19（W6 审阅后，2026-10-28）

W6 `f15ba01` 交付报告里报了 4 条契约问题，逐条核过，其中第 3 条经我实测**两条路径都会撞索引**（临时用例跑完即删）：

```
task 级：      完成 +20 → 撤销 → 走回 reviewing → 再完成
               → CONFLICT「这个任务已经发过完成分了」
occurrence 级：打卡 +1 → 撤销 → 同一天再打卡
               → CONFLICT「这一天的打卡已经发过分了」
```

根因：`rollback()` 只写负流水（`reason_code='manual_adjust'`），原 `task_done` 行原样留着；两条唯一索引的谓词都不看"是否已冲销"，重做时新行必然撞上旧行。每日任务是高频路径——误点一次撤销，当天再也打不上卡。

1. **数据模型修复（架构方直接做，不等补丁）**：`point_ledger` 加 `reversed_at`（002 迁移），两条条件唯一索引的谓词都加 `AND reversed_at IS NULL`——它们约束的是"同时最多一条有效发分行"，不是"历史上只许一条"。撤销时先 `markReversed` 给原行打时间戳（不改金额、不删行，审计仍查得出哪条被冲了、何时冲的），再写等额负行。`ledgerRepo` 因此有了**唯一一个** UPDATE。冲销只允许一次，重复冲销按内部故障 `DB_ERROR`（04 §1.2 新增「流水冲销状态异常」，只进日志）。
2. **`entriesOfOccurrence` / `hasTaskDoneEntry` / `undoCompletion` 三处补 `reversedAt === null` 过滤**：撤销→重做→再撤销时，同一天会同时存在"已冲销的旧行"与"新的有效行"，不筛就会把同一笔发分冲两次、把余额扣穿。防回归测试 `tests/db/undoRedo.test.ts` 6 条，并用"去掉索引谓词"做过反向验证（4 条立刻变红、报的正是上面两个原始错误）。
3. **新增通道 `task.undo`**（`{id}` → `{task, entry}`）：task 级撤销此前没有 IPC 入口，`undoCompletion` 写了却调不到。**同时补 24h 窗口**——01 §3 状态机早就写了 `done ──24h 内撤销──→ doing`，实现只查 `status==='done'`，隔一年也能撤；窗口外的分已进当日统计与 streak，回退会改写已"结账"的历史。超窗报 `CONFLICT`「超过 24 小时的完成记录不能撤销」（04 §1.1 已登记）。`daily` 走 `occurrence.undo`，不吃这个窗口。
4. **撤销入口放 ④ 明细的流水行**（04 §4④）：满足 `reasonCode='task_done' && occurrenceId===null && reversedAt===null` 的行尾给 `[撤销]`。**为什么不放 ①**：04 §4① 明写"已完成的限时/活动不在此列表，进 ④"，① 里根本没有已完成的行可以挂按钮；④ 的发分行就是那条完成记录本身，位置与语义都对。超窗不预隐藏（判窗口要读 `completed_at`，渲染层不重复算这条规则），交给主进程裁决后就地提示。
5. **`CompleteTaskInput` 加可选 `result`**（仅 `event`）：`AwardInput.result` 与 `resultFactor` 早就存在，但入参里没有 `result`，活动任务的 `resultFactor` 恒 ×1.0——05 W6 验收里那条 48.3 目前只能靠 deadline 路径凑出来。其他类型传了忽略，不报错。
6. **证据闸门错误码统一为 `EVIDENCE_REQUIRED`**：02 §1 的说明（v0.9）本来就为"缺证据"单列了这个码并写明"既不是 CONFLICT 也不是 INVALID_INPUT"，但 §3.2 的 `task.complete` 行写 `CONFLICT`、04 §1.1 又把它登记在 `INVALID_INPUT` 名下——同一件事三种说法。以 §1 为准：代码抛 `EVIDENCE_REQUIRED`，04 §1.1 的「证据不能为空」改到该码名下（UI 据此切"补证据"态）。
7. **STATE 口径 7 措辞纠错**：原文"任何 `Math.floor` 不得参与分值计算（现有 4 处均与分值无关）"把逾期天数那处说成"无关"不准确——它是 `penalty = overdueDays × 2` 的入参，参与分值。改成"`Math.floor` 只许用于日期/天数换算，不得对分值本身取整"。
8. **未做（归 W6 补丁）**：第 3、5、6 条的实现改动——`task.undo` 通道注册 + guards、24h 校验、`result` 入参透传、证据码改名、04 §4④ 的 `[撤销]` 接线。契约已定，等补丁。
