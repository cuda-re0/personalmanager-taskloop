**你是施工方，不是架构方。下面这份是给你的执行指令，直接照它改代码。**

---

# 92a-fix2 · 日历可折叠 + 可划动

## 执行须知（施工方必读）

1. 你是**施工方**，不是架构方。本文档是执行指令，读完就动手改代码。
2. **不要**重写/扩写/重新生成施工单，**不要**新建 `docs/kickoff/*`，**不要**先产出「实施方案 / 评审意见」。
3. 交付只贴 `git diff --stat`、自检结果、以及未能自验的条目。**不要复述本单内容。**
4. 规格里写死的 className、localStorage key、aria-label 照抄，**不要改名**。
5. 本单**只加一个图标按钮**，不加任何可见文字。

## 一、问题与定性

两件事，一件是既有缺陷，一件是新能力。

**（1）溢出（既有缺陷，不是 92a 引入的）**：`.calendar-panel` 是 `flex: 0 1 240px; min-height: 132px`、没有 `overflow`；`.calendar-grid` 是 `flex: 1 1 auto; min-height: 0`，且 `CalendarPanel.tsx` 内联给了 `gridTemplateRows: repeat(N, 1fr)`。`1fr` 等价于 `minmax(auto, 1fr)`，**最小值是行的 min-content**（日期数字 + 6px 红点行），所以容器被压到 132px 时行不会跟着缩，整体溢出约 60px，而 `.calendar-panel` 是 `overflow: visible`，于是压到下面面板头上。这是 86 单把日历改成「可压缩」时留下的。

**（2）新能力**：用户要求日历能「最小化」，把空间让给下面（积分 / 计划面板），并且展开时内容「可以划动」。

## 二、规格

### 2.1 折叠按钮（`src/renderer/main/features/calendar/CalendarPanel.tsx`）

- 新增折叠状态：`const [collapsed, setCollapsed] = useState<boolean>(() => window.localStorage.getItem(COLLAPSED_KEY) === '1')`，模块级常量 `const COLLAPSED_KEY = 'taskloop:calendar:collapsed'`。
- 切换时写 `window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')`。
- 根节点 className：`collapsed ? 'calendar-panel calendar-panel--collapsed' : 'calendar-panel'`。
- 头部结构调整：现有的 `‹` / 标题 / `›` 三个直接子项里，把 `›` 和新增的折叠按钮一起包进 `<div className="calendar-head-right">`，保证标题仍居中（`.calendar-head` 的 `justify-content: space-between` 两端分别是 `‹` 与这个右组）。
- 折叠按钮结构写死：

```tsx
<button
  aria-label={collapsed ? '展开日历' : '折叠日历'}
  className="calendar-fold"
  onClick={() => toggle()}
  type="button"
>
  <svg
    aria-hidden
    fill="none"
    height="10"
    stroke="currentColor"
    strokeLinecap="round"
    strokeWidth="1.5"
    viewBox="0 0 10 10"
    width="10"
  >
    <path d={collapsed ? 'M2 3.5 L5 6.5 L8 3.5' : 'M2 6.5 L5 3.5 L8 6.5'} />
  </svg>
</button>
```

图标方向：**折叠时箭头朝下**（点击可展开）、**展开时箭头朝上**（点击可收起）。**不许用字符符号**（`▾`/`▲` 之类），必须是 SVG；`aria-label` 是唯一文字，不显示。

文件头注释补一段：v0.94.2 起日历可折叠，折叠态只留标题行，状态记 localStorage；展开态网格内部可滚动。

> **事后更正（架构方补记）**：上文「保证标题仍居中」是错的。`space-between` 下左端是 20px 的 `‹`、右端是 38px 的右组，标题中心必然偏左 9px（`(38−20)/2`）。包进右组只解决「按钮不挤标题」，不解决居中。本单不回改，另单处理。

### 2.2 样式（`src/renderer/main/features/calendar/calendar.css`）

在文件末尾追加（**不要改现有任何规则的既有属性**，除了下面第 4 条给 `.calendar-grid` 追加 `overflow-y`）：

1. `.calendar-head-right`：`display: flex; align-items: center; gap: 4px;`
2. `.calendar-fold`：`display: flex; align-items: center; justify-content: center; padding: 2px; border: none; background: transparent; color: var(--text-sub); cursor: pointer;` 并加 `:hover { color: var(--text); }`
3. 折叠态：
```
.calendar-panel--collapsed {
  flex: 0 0 auto;
  min-height: 0;
  padding-bottom: 0;
}
.calendar-panel--collapsed .calendar-weekdays,
.calendar-panel--collapsed .calendar-grid {
  display: none;
}
```
4. `.calendar-grid` 规则体**追加**：`overflow-y: auto;`
   并新增滚动条规则，与 `.tasks-panel` 同口径（宽高 6px、轨道透明、拇指 `rgba(0, 0, 0, 0.16)`、hover `rgba(0, 0, 0, 0.28)`、`border: none`、`border-radius: 3px`、按钮 `display: none`），选择器为 `.calendar-grid::-webkit-scrollbar` 系列。

不要在 `.calendar-grid` 上写 `grid-auto-rows` 或改 `grid-template-rows`——行模板由组件内联给，本单不动。

### 2.3 修正一处**未经证实**的注释（`tests/renderer/planPanelWiring.test.ts`）

该文件的头注释与第三条用例标题里写着「会多出约 240px，撑出 `.right-half` 导致底部被裁、滚动条跑到可视区外」。这句话**在实机上没能复现**：还原 `height: 100%` 后面板高 412.9px、没有溢出，`flex-shrink` 把它拉回来了。

改成事实表述（不要保留未被证实的因果）：

- 头注释改为：`height: 100%` 是按整个下半块算的，而 `.plan-panel` 只应吃日历之后的剩余空间；这个写法依赖 flex 的隐式收缩才不出问题，换成 `flex: 1 1 auto; min-height: 0` 后行为与 `.calendar-dayview` 一致且确定。
- 第三条用例标题改为：`不再用 height: 100%：高度应来自 flex 分配，不按整块百分比算`。

**三条断言本身一个字都不改**（含 `flex: 1 1 auto`、含 `min-height: 0`、不含 `height: 100%`、含 `overflow-y: auto`）。

### 2.4 新增 wiring 断言（新建 `tests/renderer/calendarFoldWiring.test.ts`）

照 `planPanelWiring.test.ts` 的 `readFileSync` + `ruleBody` 写法，读 `calendar.css` 与 `CalendarPanel.tsx`，断言：

1. `CalendarPanel.tsx` 含 `calendar-panel--collapsed` 这个 className 分支；
2. `CalendarPanel.tsx` 含 key `'taskloop:calendar:collapsed'`；
3. `CalendarPanel.tsx` 含 `aria-label` 的 `折叠日历` 与 `展开日历`；
4. `calendar.css` 的 `.calendar-panel--collapsed` 规则体含 `flex: 0 0 auto`；
5. `calendar.css` 里折叠态把 `.calendar-grid` 置为 `display: none`；
6. `calendar.css` 的 `.calendar-grid` 规则体含 `overflow-y: auto`；
7. `calendar.css` 含 `.calendar-grid::-webkit-scrollbar`（内部滚动条已同口径）。

### 2.5 版本号

`package.json` 的 `version`：`0.94.1` → **`0.94.2`**（进单先核，若不是 0.94.1 立即停下来报告）。

### 2.6 构建产物

`npm run build`，`out/**` 与源码同批提交；`out/manifest.json` 的 `version` 必须是 `0.94.2`。

## 三、明确不做

- 不改 `.calendar-panel` 现有的 `flex: 0 1 240px` / `min-height: 132px`（展开态的可压缩行为保持 86 单的裁决）。
- 不动 `gridTemplateRows` 内联值、不动 `buildMonthGrid`、不动 `useCalendarData`。
- 不改 `CalendarDayView`、`points.css`、`tasks.css`、`plan.css`、`index.tsx`。
- 不加任何可见文字（图标是真 SVG，`aria-label` 不显示）。
- 不改 `planPanelWiring.test.ts` 的三条断言，只改注释与用例标题。

## 四、文件白名单

- `src/renderer/main/features/calendar/CalendarPanel.tsx`
- `src/renderer/main/features/calendar/calendar.css`
- `tests/renderer/planPanelWiring.test.ts`（只改注释与用例标题）
- `tests/renderer/calendarFoldWiring.test.ts`（新建）
- `package.json`（只改 version）
- `out/**`（build 产物）

## 五、验收

跑 `npm run typecheck`、`npm run lint`、`npm test`。

全量基线：**966 条 / 965 passed**，唯一允许的红是 `tests/main/chatBrief.test.ts:76` 时间炸弹（明令不修）。新增 7 条，改完应约 **973 条 / 972 passed**。

真机（这次必须跑，用 `--user-data-dir` 独立目录，别碰正在用的实例）：

1. 点箭头 → 日历只剩标题行，下面面板变高；再点 → 展开；重启后保持折叠状态。
2. 把窗口调到很矮（约 1100×560），日历展开：**滚到底能看到最后一行日期，且不压到下面面板**；`.calendar-panel` 底边与 `.calendar-grid` 可视区不重叠。
3. 折叠状态下打开计划面板，计划列表高度明显变大。

## 六、交付

1. `git diff --stat`；
2. typecheck / lint / test 三行结果原文；
3. `out/manifest.json` 的 version 与 files 条数；
4. 真机三档的实测数据（折叠前后高度、溢出是否消失）；
5. 未自验的条目明说。
