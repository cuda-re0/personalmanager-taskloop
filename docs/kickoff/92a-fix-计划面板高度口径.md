**你是施工方，不是架构方。下面这份是给你的执行指令，直接照它改代码。**

---

# 92a-fix · 计划面板的高度口径

## 执行须知（施工方必读）

1. 你是**施工方**，不是架构方。本文档是执行指令，读完就动手改代码。
2. **不要**重写/扩写/重新生成施工单，**不要**新建 `docs/kickoff/*`，**不要**先产出「实施方案 / 评审意见」。
3. 交付只贴 `git diff --stat`、自检结果、以及未能自验的条目。**不要复述本单内容。**
4. **只改一行 CSS + 加一个测试文件**，其他一律不许动。

## 一、问题与定性

92a 的 `.plan-panel` 用了 `height: 100%`。但它是 ④ 槽位的内容，不是独立整块——同一个 `.right-half` 里，上面还有 `.calendar-panel`（`flex: 0 1 240px`，`min-height: 132px`）。

对照同槽位的 `.calendar-dayview`（`calendar.css:133`）：

```
flex: 1 1 auto;
min-height: 0;
```

`height: 100%` 是按整个下半块的高度算的，比日历之后实际剩下的空间多出约 240px；再叠加 flex 子项默认的 `min-height: auto`，条目的内容高度会顶住不让压缩，结果 `.plan-panel` 撑出 `.right-half`（它有 `overflow: hidden`），**底部内容被裁掉，且滚动条整体落在可视区之外，滚不到**。

计划面板恰恰是「条目越多越需要看」的视图，这处必须修。

> **事后更正（架构方补记）**：上面这段因果**在实机上没能复现**——注入还原 `height: 100%` 后面板高 412.9px、没有溢出，`flex-shrink` 把它拉回来了。本单的准确性质是「把依赖隐式 shrink 的写法换成确定性写法」，不是修一个必然出现的 bug。

## 二、规格

### 2.1 `src/renderer/main/features/plan/plan.css`

`.plan-panel` 规则体：**删掉 `height: 100%;`**，并在同一规则体里补两行：

```
flex: 1 1 auto;
min-height: 0;
```

其余属性（`overflow-y: auto`、`box-sizing: border-box`、`padding`、`display: flex`、`flex-direction: column`、`gap`、`font-family`、`color`）**一个字都不要动**。文件里其他规则（滚动条那六条、`.plan-day`、`.plan-day-head`、`.plan-row`、`.plan-row:hover`、`.plan-row--done`）全部不动。

文件头注释补一句：高度口径与 `.calendar-dayview` 一致（吃满日历之后的剩余空间），不用 `height: 100%`——它不是整块。

### 2.2 加一条 wiring 断言（新建 `tests/renderer/planPanelWiring.test.ts`）

照 `tests/renderer/calendarDayViewWiring.test.ts` 的写法（`readFileSync` + 正则截 `.plan-panel` 的规则体），断言 **3 条**：

1. 规则体含 `flex: 1 1 auto`；
2. 规则体含 `min-height: 0`；
3. 规则体**不含** `height: 100%`。

注意正则只截 `.plan-panel { ... }` 这一段，不要被 `.plan-panel::-webkit-scrollbar...` 那几条干扰（用 `^\.plan-panel\s*\{` 锚定行首，或先按 `}` 截第一段）。

### 2.3 版本号

`package.json` 的 `version`：`0.94.0` → **`0.94.1`**（进单先核，若不是 0.94.0 立即停下来报告）。

### 2.4 构建产物

`npm run build`，`out/**` 与源码同批提交；`out/manifest.json` 的 `version` 必须是 `0.94.1`。

## 三、明确不做

- 不改 `PlanView.tsx`、`planModel.ts`、`usePlanData.ts`、`index.tsx`、`AppHeader.tsx`。
- 不改其他任何 `.css`（尤其 `tasks.css` / `calendar.css` / `points.css`）。
- 不改 `planModel.test.ts` 已有的 5 条断言。
- 不加界面文字、不加空态文案。

## 四、文件白名单

- `src/renderer/main/features/plan/plan.css`
- `tests/renderer/planPanelWiring.test.ts`（新建）
- `package.json`（只改 version）
- `out/**`（build 产物）

## 五、验收

跑 `npm run typecheck`、`npm run lint`、`npm test`。

全量基线：**963 条 / 962 passed**，唯一允许的红是 `tests/main/chatBrief.test.ts:76` 时间炸弹（明令不修）。新增 3 条，改完应约 **966 条 / 965 passed**，除 chatBrief 外不许有红。

真机（重要，这次请尽量跑）：顶栏点「计划」→ 用库里已有的带计划日任务铺满（不够就在数据库里临时把几条任务的 `planned_day` 改成不同日期）→ **滚到底部，确认最后一天完整可见、滚动条在面板内**→ 缩小窗口再试一次。

## 六、交付

1. `git diff --stat`；
2. typecheck / lint / test 三行结果原文；
3. `out/manifest.json` 的 version 与 files 条数；
4. 未自验的条目明说。
