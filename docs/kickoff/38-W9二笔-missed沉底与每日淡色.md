# 38 · W9 二笔：missed 沉底 + 每日完成行淡色 + N/M 改列表全量（v0.39）

基线：`329f296`（W9 已合入 `57288d7` / `eb4e01d`，W7 补丁 `f8ffc7e` 同时落地）。四命令 **53 文件 / 657 条**。
只动 `src/renderer/hud/**` 与两个 hud 测试。不碰主进程、不碰主窗、不碰 `hudService` / `windowManager`。

## 0. 用户裁定（原话口径）

1. 「missed 与已完成同档：沉底 + 变淡」
2. 「每日完成行恢复淡色，不加删除线」

## 1. 定性（先说清是谁的错，别复读现象）

**不是契约变更新增的口径**。`04-UI-SPEC.md` §5.3 第 638 行早在 v0.38 就写死了：

> 「已完成」= 每日 `occurrence.status === 'done'`，或任务 `status ∈ {done, missed}`。

但 `kickoff/37` §2 只写了 `done` 沉底，没把 `missed` 抄进去，施工方照 37 实现 → `missed` 掉进未完成档。**锅在 37，不在代码。**本单只是把它补齐。

现状（已核实）：
- `buildRows` 里 task 行 `done = t.status === 'done'`，`missed` 落进未完成档：不沉底、不变淡、无勾、点不动，挂在列表中间且不会自己消失。
- `missed` 是失败终点态（`stateMachine.ts:35` 只有 `archived` 一个出口），与 `done` 同属「已结束、不可再操作」。
- 今天的 occurrence 不会是 `missed`（`markMissedBefore` 只标昨天及更早），所以这一条**只在 task 行上生效**。

## 2. 行模型（`hudModel.ts`）

`buildRows` 里 task 行的 `done` 改为：状态是 `done` **或** `missed` 时为 `true`。

`HudRow.done` 的注释改写为：「已结束（完成 `done` 或判失败 `missed`）——决定沉底与变淡；每日行能否勾由 `kind === 'occurrence'` 决定，与本字段无关」。

**不改字段名、不加新字段**。理由：`done` 在渲染层的 6 个读取点（排序第 1 级、勾的 `is-done`/`disabled`/`aria-pressed`、标题的 `is-done`、`completeRow` 的幂等守卫）在语义扩展后行为**全部仍然正确**，改名只会把改动面从 3 个文件铺到 6 个。

occurrence 行不受影响：`done` 仍按 `status === 'done'`。

## 3. 组件（`HudPanel.tsx`）

两处类名，其余一律不动：

1. 行容器加修饰类：`completable` 为真时 `className="hud-row hud-row--daily"`，否则仍是 `"hud-row"`。
2. 标题的类回到「只要 `done` 就挂」：`row.done ? 'hud-row-title is-done' : 'hud-row-title'`（删掉现在的 `&& !row.completable`）。

不许动：`onClick` 三元、勾的渲染条件、`disabled` / `aria-*`、错误行。

## 3b. 计数口径（`useHudData.ts`）——用户报的「数字对不上」

现象：截图里列表 **7 行**（每日 4 + 限时 3，其中已完成 4 条），头部却写 `● 3/4`。

根因：`done` / `total` 是从 **occurrences** 算的（`total = 今日 occurrence 数`），而列表从 v0.38 起已经混进了限时/活动任务行。两套数各算各的，必然对不上。

改法：两个数都从 `rows` 派生，**不再单独 filter occurrences**（留两个真值源迟早再漂一次）：

- `total` = `rows.length`
- `done` = `rows` 里 `done === true` 的条数（`done` 已含 `missed`，见 §2）

`completionRatio` / `ratioLabel` 两个函数**不改**，长约的环与数字自动跟着变。

后果（要认）：头部 `N/M` 与长条的 `● N/M` 语义从「今日打卡率」变成「今日列表完成率」——分母含限时/活动。这是用户明确要的口径（「右边是总任务数量」）。

## 4. 样式（`hud.css`）

改准两条，**不新增选择器**：

1. `.hud-row-title.is-done` 只留 `color: var(--text-faint);`，**不加 `text-decoration`**（沿用 v0.38 的去删除线决定）。
2. 整行变淡的触发条件收窄到非每日行：
   `.hud-row-item:has(.hud-row-title.is-done) .hud-row:not(.hud-row--daily) { opacity: 0.5; }`

结果：每日已打卡 = 标题淡、行不淡；限时/活动已结束 = 标题淡 + 整行 `.5`。

`opacity:` 在全文件仍**只有这一处**（`hudWiring` 第一条钉的就是它）。

## 5. 白名单

| 文件 | 动作 |
|---|---|
| `src/renderer/hud/hudModel.ts` | §2 |
| `src/renderer/hud/HudPanel.tsx` | §3 |
| `src/renderer/hud/useHudData.ts` | §3b |
| `src/renderer/hud/hud.css` | §4 |
| `tests/renderer/hudModel.test.ts` | §6 |
| `tests/renderer/hudWiring.test.ts` | §6 联动（选择器串变了，不改必红） |

不许碰：`src/main/**`、`src/shared/**`、主窗任何文件、`hudService.ts`、`windowManager.ts`、`docs/**`。

## 6. 测试

`hudModel.test.ts` 在「列表拼装」describe 内加两条：

1. **missed 沉底**：一条未完成限时 + 一条 `missed` 限时 → `missed` 排在后，且 `completable === false`。
2. **missed 与 done 同档**：一条 `done` + 一条 `missed` → 两者都排在未完成行之后（两者之间不要求顺序）。

`hudWiring.test.ts`：
- 第 172 行的选择器串改成 `.hud-row-item:has(.hud-row-title.is-done) .hud-row:not(.hud-row--daily) {`，`opacity: 0.5` 的断言不变。
- 加一条：`hud-row--daily` 只出现在 `completable` 为真的分支里（照现有 `row.completable ? (` 的写法对齐，别引入新写法）。
- 加一条：`useHudData` 里 `done` / `total` 不再对 `occurrences` 做 filter/length（钉住 §3b 的单真值源）。

## 7. 验收（三条）

1. **每日完成行**：悬浮窗勾一条每日 → 标题变淡、整行**不变淡**、落最底、勾实心。
2. **数字对得上**：数一眼列表有几行、几个勾，头部 `N/M` 必须与肉眼所见一致（例：7 行、4 条已完成 → `● 4/7`）；长条的 `● N/M` 同步跟着变。
3. **missed 行**：需要「reviewing 被驳回 + 已过 due」才能造，手点成本高。**先保证 §6 第 1 条单测绿**；真机造不出来就如实写「未真机造出 missed，模型层已钉」，**不要改库伪造**。

## 8. 自检

- [ ] 四绿（基线 53 文件 / 657 条，本单只许变多）
- [ ] `git show --stat` 对照 §5，越界 0
- [ ] `grep -n "opacity:" src/renderer/hud/hud.css` → 只有一行，即 `.hud-row-item:has(.hud-row-title.is-done) .hud-row:not(.hud-row--daily) { opacity: 0.5 }`
- [ ] `grep -n "text-decoration" src/renderer/hud/hud.css` → 不含 `.hud-row-title` 相关的任何一条
- [ ] §7 三条：真机做了几条、造不出哪条，如实写
