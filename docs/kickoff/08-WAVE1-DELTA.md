# 波次 1 · 开工词补充（v0.5 → v0.7 差异）

> **为什么有这份文档**：`01`–`06` 六份模块开工词写于契约 v0.5。之后契约经历了两次变更，
> 而开工词没有逐份重写（改 6 份会漂移 6 次）。下面每条都是**硬变更**：
> 与你手上的模块开工词冲突时**以本文为准**，本文没提到的以 `docs/` 为准。
>
> **契约冻结**：git tag `contract-v0.7`（commit `c58e0c8`）。你读的 `docs/` 应为该 tag 的内容，
> 若不是（例如发现文档比你开工词还旧），停下来报告，不要按旧版实现。

---

## 全局（6 个模块都受影响，逐条核对你有没有踩）

### D1 · 积分是小数，不是整数

这是最容易踩的一条，因为**肉眼看不出来**：

| 位置 | 值 |
|---|---|
| DDL 字段类型 | `tasks.points_planned` / `tasks.points_awarded` / `task_occurrences.points_awarded` / `point_ledger.delta` / `daily_stats.points` 全部 **`REAL`**，不是 `INTEGER` |
| 精度收敛 | `roundPoints(v) = Math.round(v * 100) / 100`，**全项目只允许这一处**出现 `Math.round` / `toFixed` |
| 公式里不再取整 | `computePlannedPoints` 直接返回 `clamp(roundPoints(raw), 1, 100)`，不 `Math.round` 成整数 |
| `RUBRIC_VERSION` | `'v0.6-b'` |

典型值（用于自查，不是猜的）：

```
trivial  5 min  → 5.06
trivial 60 min  → 5.75
easy    30 min  → 10.75
medium  60 min  → 23
hard   120 min  → 45.5      ← 旧文档写 42 是算错，已改
epic   240 min  → 80
computeAwardedPoints(10.75, 'partial', 0) → 6.45
```

**UI 显示统一走 `fmtPoints`**（`04-UI-SPEC.md` §6）：最多 2 位小数、去掉尾零。
`23` → `23`，`5.75` → `5.75`，`45.5` → `45.5`，`80` → `80`。不要写 `23.00`。

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
- `task.complete` 入参是 `{ id: string; quality: Quality; evidence?: string[] }`。
- **硬校验在 service 层**：`requiresEvidence === true` 且 `evidence` 为空 → **停在 `reviewing`、不入账**，
  返回 `AppError{ code: 'EVIDENCE_REQUIRED' }`。不能只在 UI 拦——绕过界面直接调 IPC 也拿不到分。
- 连续 3 次补不上证据，UI 给一个 `[直接标记完成（不计分）]` 出口。这是防死锁，点了就是 0 分。
- **不存在"先入账再追问"**。v0.4 时期有过这个口子，已删除。有例外就等于没有证据要求。

### D4 · 交付前自己跑这两条

```
npm run typecheck
npm run lint
```

两条都 exit 0 才算交付。只写"我认为没问题"不算。

---

## 分模块补充

### W1 · 数据层

1. **授权目录增加 `tests/shared/**`**（原开工词没有）。
2. **新增交付项**：`tests/shared/rubric.test.ts`。按 `02 §5.2` 示例表逐行断言六组
   `computePlannedPoints` + `computeAwardedPoints` 的质量系数与逾期扣分。
   **只测不改**：`rubric.ts` 若与 02 不一致，报告，不要自行修正。
   配 vitest，`npm test` 要能跑。
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
4. 草稿卡片的"分值"是 `pointsPlanned`，来自 `computePlannedPoints`，可能带小数
   （改难度/时长后即时刷新，走 `points.preview`）。

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
