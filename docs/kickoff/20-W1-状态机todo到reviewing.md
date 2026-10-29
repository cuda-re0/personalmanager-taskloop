# W1 · 状态机修复：`todo → reviewing` 未接通（P0）

> **身份**：你是**施工方**。规格由架构方定，本文即规格。
>
> **起点**：`9ac34b4`（W6 明细页 `4be440b` 已合入但审核不通过、正在返工；42 文件 / 495 条全绿，工作区干净）。
> 开工前跑 `git diff --stat 9ac34b4 HEAD -- src/main/db/stateMachine.ts docs/01-DATA-MODEL.md`，**必须为空**——这是你唯一会碰的两个既有文件。
> **与 W6 返工并行**：W6 正在改 `src/renderer/main/features/points/**` 和 `src/renderer/main/index.tsx`，与你的文件范围**零交集**（`git diff --stat 3183913 9ac34b4 -- src/main src/shared docs/01-DATA-MODEL.md` 为空，你的两个既有文件自 `3183913` 起没被动过）。**那些文件不要碰、不要提交**。
> 并行的副作用：`npm run typecheck` / `npm test` 是全量的，会看到对方半成品。若报错落在 `points/**` 或 `index.tsx`，**不算你的**——先用 `npx vitest run tests/db` 单独跑自己那一摊，报告里注明红在哪、与谁相关，不要试图去修别人的文件。

---

## 0. 缺陷是什么（真机实测，不是推测）

在 `3183913` 上跑起来，新建一条限时任务（`status = todo`），展开点 `[完成]`，**行内红字报出**：

```
任务不能从「待办」直接变为「待确认」
```

即：`submitAndComplete` 第一步 `task.transition({ to: 'reviewing' })` 被状态机拒绝。

根因两处，缺一不可：

1. `src/main/db/stateMachine.ts` 的 `EDGES.todo = ['doing', 'discarded', 'archived']` —— **没有 `reviewing`**。
2. `src/renderer/main/features/tasks/useTasksData.ts` 的 `submitAndComplete` 直接调 `transition('reviewing')`，而界面**根本没有「开始」按钮**（`grep -n "开始" src/renderer/main/features/tasks/*.tsx` 为空）。

于是：**任何还没「开始」的限时/活动任务，点完成必定失败**（任务永远停在 `todo`，不入账、无流水、也无从撤销）。每日任务走 `occurrence.complete`，不受影响——这就是为什么库里只有打卡流水、没有任务完成流水。

`01 §3` 自己就要求这条边存在：

> **`event` 的自动流转**：`due_at` 过后 24 小时仍是 `todo`/`doing` 时，调度器把它推进到 `reviewing`

所以不是"要不要放宽"，是**状态机与契约不一致**，以契约为准。

---

## 1. 裁决（架构方，v0.25）

**允许 `todo → reviewing`。** 理由三条，按权重：

1. 界面没有「开始」按钮，`todo` 是新建任务的默认态；不让它提交，等于完成功能对新建任务全废。
2. `01 §3` 已要求调度器做 `todo → reviewing`（W8 未开工，但那天空转就是同一个坑）。
3. 语义正确：「提交完成」本身就隐含「我已经开始了」，不要求用户先点一个不存在的按钮。

**不选的做法**（报告里若有人提，按这条驳回）：渲染层先 `doing` 再 `reviewing` 两次 IPC——中间态会落库（`started_at` 被写），第二步失败时任务停在 `doing`，凭空多一个"我什么时候开始的"状态。

---

## 2. 改哪（三个位置，多一处都算越界）

```
src/main/db/stateMachine.ts          EDGES.todo 加 'reviewing'，并更新文件头注释里的状态图
docs/01-DATA-MODEL.md                §3 状态图与说明按 §4 给定文本替换
tests/db/**                          补 4 条用例（§3）
```

**不许动**：`src/renderer/**`（`submitAndComplete` 已经是对的，别去"顺手改"）、`src/main/services/**`、`src/main/ipc/**`、`01` 以外的 `docs/**`、`tests/db/complete.test.ts` 与 `tests/db/task.test.ts` 的既有断言（见 §3 末段）。

---

## 3. 代码改法

`src/main/db/stateMachine.ts`：

```ts
const EDGES: Record<TaskStatus, TaskStatus[]> = {
  // v0.25：todo 可直达 reviewing。界面没有「开始」按钮，新建任务默认就是 todo，
  // 不允许这条边等于「新建的限时/活动任务永远完不成」。01 §3 的调度器同样需要这条边。
  todo: ['doing', 'reviewing', 'discarded', 'archived'],
  doing: ['todo', 'reviewing', 'discarded', 'archived'],
  reviewing: ['doing', 'done', 'discarded', 'archived'],
  done: ['doing', 'archived'],
  discarded: ['archived'],
  archived: []
}
```

文件头注释的状态图改成（保持 ASCII，别用花哨字符）：

```
 *   todo ──开始──→ doing ──提交完成──→ reviewing ──通过──→ done
 *    │               │  ↑                  │                  │
 *    └──提交完成──────┘  └──驳回────────────┘                  │
 *    └──放弃──────────┘                                        │
 *                                                             │
 *   done ──24h 内撤销──→ doing（同时写一条负流水冲销）
 *   任意状态 ──归档──→ archived
```

`isTransitionAllowed` 的 daily 守卫**一个字不要动**（`daily` 仍禁止进 `reviewing` / `done`，那是另一条硬约束）。

### 测试（新建 `tests/db/stateMachine.test.ts`）

| # | 用例 | 断言 |
|---|---|---|
| 1 | `todo → reviewing`（deadline） | 允许，且 `startedAt` 仍为 `null`（**不许**偷偷写 `started_at`） |
| 2 | `todo → reviewing`（event） | 允许 |
| 3 | `todo → reviewing`（daily） | 仍是 `CONFLICT`，消息为 `每日任务不进入审核/完成状态，请完成当天的打卡` |
| 4 | 端到端：新建 todo 限时任务 → `transition('reviewing')` → `completeTask({quality:'met'})` | 状态 `done`，`point_ledger` 多一条 `reason_code='task_done'`、`occurrence_id IS NULL` 的行，余额 +应得分 |

**不要改** `tests/db/complete.test.ts:122`（`todo 直接完成 → CONFLICT`）：它调的是 `completeTask` 且**没先 transition**，`task.complete` 仍要求 `reviewing` 前置状态，这条断言依然成立。同样 `tests/db/task.test.ts` 的 `todo → doing → reviewing 通过` 也不用改（它只断言这条路径通，没断言另一条不通）。

---

## 4. 契约替换文本（`docs/01-DATA-MODEL.md` §3）

把状态图那行：

```
  会话卡片 ──确认──→ todo ──开始──→ doing ──提交完成──→ reviewing ──通过──→ done
```

换成：

```
  会话卡片 ──确认──→ todo ──开始──→ doing ──提交完成──→ reviewing ──通过──→ done
                      │                    ↑
                      └────提交完成────────┘
```

并在该图下方第一条说明（`- `draft` **不是** tasks 的状态…`）**之前**插入：

```markdown
- **`todo → reviewing` 是合法边（v0.25）**：界面没有「开始」按钮，新建任务默认就是 `todo`，不允许这条边等于「新建的限时/活动任务永远完不成」。这条边**不改 `started_at`**（没开始过就是没开始过），`task.complete` 仍要求前置状态为 `reviewing`。调度器（W8）判定 `event` 超期时走的也是这条边。
```

---

## 5. 验收自检

| # | 口径 | 判定 |
|---|---|---|
| 1 | 只改 §2 列的三处 | `git status --porcelain` 逐行核对 |
| 2 | `daily` 硬约束未松动 | 用例 3 通过 |
| 3 | `todo → reviewing` 不写 `started_at` | 用例 1 通过 |
| 4 | 端到端入账 | 用例 4 通过（`occurrence_id IS NULL` + 余额） |
| 5 | 全量测试绿 | `npm test`，起点 463，交付后 ≥ 467 |
| 6 | 四项命令零错 | `typecheck` / `lint` / `build` |
| 7 | 提交带 pathspec | 禁止裸 `git commit`（W6 有未提交改动在同一个工作区） |

---

## 6. 真机验收（自己跑，别只说"通过"）

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npm run build; npm start
```

1. 右栏 ① 点 `+` 新建一条限时任务，标题随便
2. 展开它，点 `[完成]`
3. 期望：任务从「限时」组消失（进 `done`），余额增加，④ 出现一条流水，**行尾有 `[撤销]`**
4. 点那条 `[撤销]`：余额回落，任务回到「限时」组
5. 再新建一条，直接点完成 → 仍应先出现确认条（步骤没勾的那种才弹；无步骤的直接完成）

第 3 步的 `[撤销]` 是本轮的关键指标：**它就是用户一直在找的东西**，此前因为任务永远完不成，流水里根本没有可撤销的行。

---

## 7. 报告

六段：改动清单 / 自检（§5 逐条）/ 测试增量（用例 1–4 的结果）/ 手点记录（§6 逐条）/ 与本文不一致处 / 留给架构方的事。

**特别说明**：如果你觉得 `todo → reviewing` 会带来别的问题（例如某处代码假设 `reviewing` 任务一定 `started_at` 非空），**不要自己加兼容代码**，写进报告由架构方裁决。
