# W6 · 明细改成面板内标签 + 右栏加宽 + 去掉撤销（v0.26）

> **起点**：`8be218a`。开工前跑 `git log --oneline -3` 确认——若 HEAD 比它多出一笔
> `docs: v0.26`，那笔是本开工词自身，等价，直接在上面做。
> `git status --porcelain` 应为空；非空停下来问。
>
> **必读**：`docs/04-UI-SPEC.md` §2（栏宽）、§4④（整节已重写）、§1（文案纪律）。
> `docs/STATE.md` §三（十条口径）。

用户 14:08 在真机上看过新版之后提了三条，全部集中在 ④ 面板和两栏比例上。
**v0.24/v0.25 那套「整窗明细页 + 覆盖层隐藏工作台」整体作废**，不是打补丁，是换形态。

---

## 1. 本轮你要做的三件事

### A. 明细从「整窗页」改成 ④ 面板里的第 4 个标签

现在：④ 的 tabs 行最右有个 `›`，点开是整窗 `LedgerPage`，盖住整个工作台，页头有 `←` 返回。

要变成：tabs 行变成**四个**标签 `今日 / 本周 / 本月 / 明细`，点 `明细` 时，
**③ 积分以下的整块区域就地换成明细视图**（月导航 + 按日分组），其余一切不动。

具体尺寸与结构（照这个做，别自己发挥）：

| 部件 | 规格 |
|---|---|
| tabs 行 | 沿用 `.points-tabs`，四个 `.points-tab`，`明细` 排最后；不新增「选中」样式，沿用 `--on` |
| 明细选中时 | 平铺列表整块替换；③ 积分（大数字 + 柱状）**始终在**；四个标签**始终可点** |
| 月导航行 | 高 32px，左 `‹`、中 `2026年10月`、右 `›`；行尾当月净额（含符号，正数主色、负数灰红） |
| 列表 | 按 `day` 分组，组头 `10月28日` 吸顶（背景 `--bg`、12px、`--text-faint`）；组内 `createdAt` 降序 |
| 行 | 高 32px = `HH:mm` + 标题（超长省略）+ `±N`；整行一个按钮，点它 `emitFocusTask(taskId)` |
| 已冲销行 | 整行 `opacity: .5`（历史数据可能有），不加文字、不加 tooltip |
| 空月 | 只有月导航 + 空白列表区；**不许写「暂无记录 / 今天 / 昨天」** |
| 滚动 | 只在明细列表这一块滚；外层不许再出滚动条，横向一律不许 |

**翻月判据（v0.25 的教训，别退回旧写法）**：
- 落月**不得晚于本月** → 守卫写 `next <= 本月`（不是 `<`）。
- 到达当月，`›` 就 `disabled`；`‹` 不设最早边界。
- 上一单已有「过去 24 个月，按钮亮着就必须动」的不变量测试，**保留**。

### B. 删掉整窗明细页的整套机制

要删干净，不留死代码：

| 位置 | 删什么 |
|---|---|
| `renderer/main/index.tsx` | `MainView` 类型、`view` 状态、`openLedger` / `backToWorkbench`、`LedgerPage` 的 import 与挂载、外层 `position:relative` 容器与 `app-shell` 上的 `visibility` / `pointerEvents` / `position:absolute` 内联样式。**回到 v0.23 之前的简单结构**：列容器 + `AppHeader` + `.app-shell` |
| `features/points/PointsPanel.tsx` | `onOpenLedger` prop、`aria-label="明细"` 的 `›` 按钮 |
| `features/points/LedgerPage.tsx` | 文件改名为 `LedgerView.tsx`，改成面板内组件：去掉 48px 页头与 `←` 返回，去掉整窗 `absolute inset:0`，接受「当前月份 / 净额 / 行点击」三类 props |
| `features/points/useLedgerPage.ts` | 改名 `useLedgerView.ts`，逻辑基本不动：月份状态 + `points.ledger(limit 500)` / `points.monthStats` 两路并发 + 序号护栏 + `points.changed` / `daystats.changed` 重拉 |
| `features/points/points.css` | 删 `.ledger-page*` 全部；新增月导航、分组头、行样式（只准用 tokens 变量） |

**性能要求**：`明细` 没被选中时**不许发请求**。现在是「进右栏就拉两次 IPC」，
改成「第一次点 `明细` 才拉」，之后靠 `points.changed` 刷新。

### C. 去掉撤销入口（用户明确要求）

用户原话：「撤销这个功能去掉，不需要。」

- 删：④ 流水行尾的 `[撤销]` 按钮、`usePointsData.undo`、`pointsModel.canUndoEntry` 及其注释。
- **主进程不动**：`task.undo` 通道、`taskService.undoCompletion`、`pointsService.rollback`、`ledgerRepo` 全部保留，`tests/db/**` 里那 26 条含 undo 的用例**一条都不许改**。
- 收口口径：`grep -rn "task.undo" src/renderer` 必须为空；`grep -rn "撤销" src/renderer` 必须为空。

### D. 右栏加宽 + 右边留白（一次性授权，改完不许多碰）

- `.right-col`（`features/tasks/tasks.css`）：`flex: 0 0 400px` / `width: 400px` / `min-width: 400px` → **460px**，三处一起改。
- `.chat-panel` 的 `min-width: 520px` **不许动**。
- `src/main/windowManager.ts`：`minWidth: 940` → **980**（460 + 520，保证最小窗口下左栏不被压破）。
- ④ 内容右侧留白：`.points-summary`、`.points-tabs` 的右 padding `16px` → `20px`；`.ledger-list` 右 padding 调到「行内再算 8px 后，内容距右边缘正好 20px」。左侧仍 16px。
- **前提**：`STATE.md §四` 记的「`.ledger-list` 宽 383 / 内容 391，横向滚 8px」这条要在这轮消失——加宽后复测，若仍有溢出，在行内补 `min-width: 0`，**不许用 `overflow-x: hidden` 掩盖**。

---

## 2. 你能改的文件（白名单，超出即 P0）

```
src/renderer/main/index.tsx
src/renderer/main/features/points/PointsPanel.tsx
src/renderer/main/features/points/LedgerView.tsx        (由 LedgerPage.tsx 改名)
src/renderer/main/features/points/LedgerPage.tsx        (删除)
src/renderer/main/features/points/useLedgerView.ts      (由 useLedgerPage.ts 改名)
src/renderer/main/features/points/useLedgerPage.ts      (删除)
src/renderer/main/features/points/usePointsData.ts
src/renderer/main/features/points/pointsModel.ts
src/renderer/main/features/points/ledgerModel.ts         (只读；翻月逻辑一个字不许改)
src/renderer/main/features/points/points.css
src/renderer/main/features/tasks/tasks.css              (只许改 .right-col 那三个数)
src/main/windowManager.ts                               (只许改 minWidth 一个数)
tests/renderer/**
```

**明确不许碰**：`src/main/services/**`、`src/main/db/**`、`src/preload/**`、`src/shared/**`、
`src/renderer/shared/styles/chat.css`、`src/renderer/main/features/chat/**`、
`src/renderer/main/features/tasks/*.tsx`、`docs/**`。

---

## 3. 测试要求

### 3.1 要删的

- `tests/renderer/pointsModel.test.ts` 里 `canUndoEntry` 的 3 条（函数没了）。
- `tests/renderer/ledgerPageWiring.test.ts` 整份重写为 `ledgerViewWiring.test.ts`：
  原文件里那些「整窗页头 48px」「`←` 返回」「工作台不在条件分支」「`hidden=` 禁用」「`pendingFocus` 已消失」的断言**全部作废**——那些断言的保护对象已经不存在了。

### 3.2 要保留的

- `tests/renderer/ledgerModel.test.ts` 全部（13 条纯函数 + 翻月 7 条 + 「过去 24 个月按钮亮着就必须动」）。**一条不许删、不许改期望值**。

### 3.3 要新增的（至少这些，鼓励多写）

1. `PointsPanel` 的 tabs 有四个，第四个是 `明细`，且**没有** `aria-label="明细"` 的按钮。
2. 选中 `明细` 时点 `今日` 能回到平铺列表（视图与范围是两套状态，互不污染）。
3. 明细视图里**没有**「撤销」两个字、**没有** `task.undo` 调用。
4. 源码级：`index.tsx` 不含 `LedgerPage` / `useState<'workbench'` / `visibility`；`grep task.undo src/renderer` 为空。
5. 源码级：`.right-col` 是 460、`windowManager` 的 `minWidth` 是 980（锁住这两个数，防止谁手滑改回去）。
6. 「明细未选中时不发请求」——用一个 stub 计数断言 `points.ledger` 调用次数为 0，选中后为 1。

起点基线：**43 文件 / 508 条**。删掉约 4 条旧的、加上新的，最终数字你自己报，**只要全绿**。

---

## 4. 自检表（交付时逐条给判定 + 证据）

| # | 检查 | 怎么判 |
|---|---|---|
| 1 | 整窗明细页彻底消失 | `grep -rn "LedgerPage\|openLedger\|backToWorkbench" src/renderer` 为空 |
| 2 | 撤销入口彻底消失 | `grep -rn "撤销\|canUndoEntry\|task.undo" src/renderer` 为空 |
| 3 | 主进程零改动 | `git show --stat <你的提交> -- src/main` 只应有 `windowManager.ts` 一行；`git diff --stat -- src/main/db src/main/services src/preload src/shared` 空 |
| 4 | 栏宽与最小窗口 | `.right-col` 460 三处、`minWidth: 980`；断言见 3.3-5 |
| 5 | 右侧留白 20px | 真机量 `.ledger-list` 右内边距与最后一行的间距；截图或 DOM 测量数字 |
| 6 | 无横向滚动条 | ④ 任意 tab 下 `scrollWidth <= clientWidth` |
| 7 | 明细不预请求 | 未点 `明细` 时 `points.ledger` 调用 0 次 |
| 8 | 空月留白 | 退到空月，只有月导航，页面无任何中文字面量 |
| 9 | 四命令全绿 | `typecheck=0` / `lint=0` / `test=0` / `build=0`，报出文件数与条数 |
| 10 | 提交带 pathspec | `git commit -F msg -- <白名单路径>`，不许裸 `git commit` |

---

## 5. 真机手点（必须真机，起不来就如实写起不来）

环境（`17-交付验收流程.md §3.1` 已定死，照做）：

```bash
# 必须写成一行，否则第一个命令不生效
Remove-Item Env:ELECTRON_RUN_AS_NODE -EA SilentlyContinue; npm run build; npm start
```

- 用 `--user-data-dir=<临时目录>` 起实例，避免连到别人的真实库；
- 先用 `netstat -ano | findstr 9333` 查端口占用，被别人占了就换一个；
- 连上先核对身份：**临时库应该是空的**，页面却有任务 = 连错窗口，立刻停、重来。

按顺序走完这 8 步，逐步记「看到什么」，不只是打勾：

1. 右栏比之前宽了，会话区窄了；把窗口拖到最小：**左栏没被压破、右栏仍是 460、没有横向滚动条**。
2. ④ 的 tabs 是 `今日 本周 本月 明细` 四个，最右**不再有 `›`**。
3. 点 `今日` → 点 `明细`：③ 大数字和柱状图还在，下面整块变成月导航 + 按日分组的列表，**没有 `←`、没有跳页、左栏消息和输入框看不出任何变化**。
4. 在输入框打几个字 → 点 `明细` → 点 `今日` → **字还在**。
5. 明细里点 `‹` 退到 9 月，再点 `›` → **回到 10 月**；10 月时 `›` 是灰的。
6. 明细里点任一行 → 右栏 ① 对应任务高亮约 1 秒（**不切视图、不闪**）。
7. ④ 任意 tab、任意月份下，**行尾都没有 `[撤销]`**。
8. 退到一个没有流水的月份 → 只有月导航 + 空白，**没有任何提示文案**。

---

## 6. 交付报告格式

按六段写（照 `kickoff/17`）：改动清单 / 自检表 / 测试增量 / 手点记录 / **与本文不一致处** / 留给架构方的事。

第 5 段不许省。上一单两次都是靠这段发现我自己的规格写错（ASCII 状态图、基线数）。
发现本单里数字不合理（比如 460 让 ① 的行太挤），**不要自己调**，先按规格做，然后写进第 5 段报上来。
