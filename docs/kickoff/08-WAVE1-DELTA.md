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
5. `db/index.ts` 加 `export * as attachmentRepo`，与其余六个 repo 口径一致（已由架构方加好）。
6. **`width` / `height` v1 留 `null`**，不引入图片解码依赖；UI 不要靠尺寸占位。
7. `read()` 的 id 形状不合法与查不到行一样返回 `NOT_FOUND`，不在读盘前区分两种失败。

另登记两条此前漏掉的文案（W11 实现里已经在用）：`INVALID_INPUT`「附件内容为空」「附件存放路径非法」、`FILE_TOO_LARGE`「附件超过 {N} MiB 上限」。
