# W9 重做 · 悬浮窗形态（v0.21）

> **这份开工词是自包含的**：不读其它会话记录也能施工。必读章节：`04-UI-SPEC.md` §5（悬浮窗）、`02-CONTRACTS.md` §3.7b（hud 通道）、§3.0（AppSettings）。
> **起点**：`cbf5eca`（工作区干净，395 条测试全绿，typecheck / lint / build 零错）。

## 0. 为什么重做

用户真机手点后否掉了现在这套形态，原话：

> 顶部那条（dock 横条）离不开顶部（预想应该是和悬浮窗一样）；可自由拖动，有删除项，现在那右上角三个点是它形式转换的按钮，太怪了。还要能自己改背景颜色和透明度。收起来后的圈圈也要能拖动（这个可以做一定距离内自动吸附）。

已由架构方与用户逐条确认，**下面四条是定论，不要再问**：

| # | 决策 |
|---|---|
| 1 | 贴边球**只贴屏幕左、右两侧**（不做上/下/四角） |
| 2 | **删掉 dock-bar 全宽横条**，只留「贴边球」与「便签窗」两种形态 |
| 3 | 背景颜色 / 透明度 / 关闭悬浮窗，**全部放 HUD 内的右键菜单** |
| 4 | 形态切换**拖动中实时判定**（不是松手才判） |

## 1. 交付边界

**要改的文件（全部在仓库内，路径给全）**

```
src/shared/types/ipc.ts                     HudMode 值域、AppSettings 两个 key 增删、HudApi 去掉 setExpanded
src/shared/channels.ts                      删 hud.setExpanded
src/main/ipc/guards.ts                      删 hudSetExpanded、hudModeSchema 改值域
src/main/ipc/registry.ts                    删 setExpanded 那行、更新 hud 段注释与条数
src/main/db/defaultSettings.ts              hud.mode / hud.background / hud.opacity / 删 hud.expanded
src/main/services/hudService.ts             状态机与几何**重写**（见 §2）
src/main/windowManager.ts                   HUD 建窗注释与 movable 说明
src/preload/index.ts                        删 setExpanded、getState 返回类型
src/renderer/hud/FloatPod.tsx               改成两个外壳组件（PeekBall / NoteWindow）
src/renderer/hud/DockBar.tsx                **删除**
src/renderer/hud/HudPanel.tsx               去 variant、去 `⋯`、头部改为拖动把手
src/renderer/hud/index.tsx                  按 mode 渲染两个外壳
src/renderer/hud/useHudData.ts              去 expanded/recentTitle，actions 改 openNote/closeNote
src/renderer/hud/hudModel.ts                删 recentTitle
src/renderer/hud/hud.css                    重写外壳部分（peek / note）
src/renderer/hud/HudContextMenu.tsx         **新增**：右键菜单 + 颜色/透明度面板
tests/main/hudService.test.ts               重写（几何 + 状态机）
tests/ipc/hudChannels.test.ts               更新通道清单
docs/02-CONTRACTS.md                        按 §6 给定文本替换
docs/04-UI-SPEC.md                          按 §6 给定文本替换
```

**不许碰**：`src/main/services/{task,points,occurrence,message,attachment}Service.ts`、`src/main/db/**`（除 `defaultSettings.ts`）、`src/renderer/main/**`、`src/renderer/shared/**`、`tests/ipc/{promoteDraft,registry,w6Channels}*.test.ts` 的断言（除非通道条数变了，那时只改条数那一个数字）。

## 2. 形态与几何（核心）

### 2.1 两种形态

| mode | 尺寸 | 位置 |
|---|---|---|
| `peek` | `56 × 56` | 贴屏幕**左或右**边缘，`y` 自由（clamp 进工作区） |
| `note` | `360 × min(480, workArea.height)` | 自由位置，**左右各留 ≥48**，不贴死 |

`HudMode = 'peek' | 'note'`。旧的 `'dock-bar'` / `'float-pod'` 作废；库里存着旧值时**一律按 `peek` 起**（`settingRepo.get('hud.mode')` 的结果当 string 比对，不认识就 `peek`）。

### 2.2 常量（写死，不要自己调）

```ts
PEEK_SIZE = 56          // 球直径
PEEK_INSET = 24         // 无记忆坐标时距右上角内缩
NOTE_WIDTH = 360
NOTE_MAX_HEIGHT = 480
NOTE_EDGE_GAP = 48      // 便签窗展开后距左右边至少留这么多
EDGE_SNAP = 24          // 便签窗距边 ≤24 → 收成球
EDGE_RELEASE = 48       // 球距边 >48 → 展开成便签窗
MOVE_DEBOUNCE_MS = 120  // 拖动中实时判定的去抖窗口
```

### 2.3 纯几何函数（全部导出，测试直接打）

```ts
clampInto(workArea, rect): Rect
edgeGap(workArea, rect): number        // min(左距, 右距)，负=已出界
nearEdge(workArea, rect): 'left' | 'right'
defaultPeekPoint(workArea): Point      // 右上角内缩 24
peekBoundsFor(workArea, rect): Rect    // 按 rect 中心所在半屏决定贴哪边
noteBounds(workArea, x, y): Rect       // 左右各留 48，屏太窄则水平居中
noteRectFromPeek(workArea, peekRect): Rect
peekRectFromNote(workArea, noteRect): Rect
resolveDragStep(mode, workArea, rect): HudMode | null
```

**`resolveDragStep` 的语义**：返回目标形态，`null` 表示"这个位置不构成形态变化"。判定只有两条：

```
mode === 'peek'  →  edgeGap(rect) >  EDGE_RELEASE  ? 'note' : null
mode === 'note'  →  edgeGap(rect) <= EDGE_SNAP     ? 'peek' : null
```

中间地带（24 < gap ≤ 48）保持原形态——这是滞回区间，防止来回抖。

**防死循环的关键约束（必须写测试）**：`noteRectFromPeek` 的输出必须满足 `edgeGap(...) > EDGE_SNAP`。因为展开后左右至少留 `NOTE_EDGE_GAP`(48) > `EDGE_SNAP`(24)，所以"刚展开就被判成贴边又收回去"不可能发生。这条是整套设计的命门，**必须有一条测试直接断言它**，否则施工方以后调一个数字就会让 HUD 疯狂闪烁。

### 2.4 拖动中实时变形

`move` 事件 → 去抖 `MOVE_DEBOUNCE_MS` → 判一次：

```
rect = win.getBounds()
if (rect 与 state.bounds 的 x/y 相同) return    // 程序化 setBounds 的回声，必须丢
area = displays.nearestWorkArea(rect)
next = resolveDragStep(state.mode, area.workArea, rect)
if (next) { state.mode = next; persist hud.mode; applyBounds(); broadcast hud.mode.changed }
else      { state.bounds 的 x/y 更新为 rect 的位置; persist hud.position }
```

- 回声抑制不能省：`applyBounds()` 会再触发一次 `move`，不比对就会无限自我切换。
- 形态变了才 `setBounds`；没变时**只记位置**，不要重排窗口（否则拖动手感会顿）。
- 已知风险：Windows 上在拖动过程中 `setBounds` 有可能打断拖拽。若实测手感断裂，**不要自己改设计**，在交付报告里写明「实时变形导致拖拽中断，建议改为松手判定」，由架构方裁决。

### 2.5 形态切换（点击 / ESC）

`setMode(mode)`：

- `peek → note`：`noteRectFromPeek(workArea, 当前球 bounds)`
- `note → peek`：`peekRectFromNote(workArea, 当前窗 bounds)`
- 落库 `hud.mode`，`applyBounds()`，广播 `hud.mode.changed`

调用方只有两处：球心热区点击 → `openNote()`；便签窗内 ESC → `closeNote()`。

**删除 `hud.setExpanded` 全链路**（channels / guards / registry / preload / `HudApi` 类型 / 渲染层）。形态由位置决定，没有独立的"展开态"；`hud.expanded` 这个 settings key 一并从 `AppSettings` 删除，**旧库里残留的行不用迁移**，只是再也读不到。

## 3. 右键菜单（新增）

`src/renderer/hud/HudContextMenu.tsx`：HUD 窗口内**自绘**的菜单（不是 Electron 的 `Menu`），因为颜色/透明度要即时预览。

- 触发：在 HUD 上 `contextmenu`（球和便签窗都要能触发）。
- 三项，**文字就是这三个，不许加别的**：
  1. `背景颜色` → 展开一个取色器（`<input type="color">`）
  2. `透明度` → 一个滑杆（`min 0.3 max 1 step 0.05`）
  3. `关闭悬浮窗` → `hud.setVisible({ visible: false })`
- 改动即时落库：`app.setSetting({ key: 'hud.background', value })` / `{ key: 'hud.opacity', value }`。
- 点菜单外部关闭菜单。
- 菜单与滑杆必须 `-webkit-app-region: no-drag`，否则点不动。

**背景渲染方式（重要）**：不要把 `opacity` 加到容器上——那会把文字一起弄透明。渲染层把两个 settings 合成一个 `rgba(r,g,b,a)` 字符串，写进 CSS 变量 `--hud-bg`，CSS 里 `.peek-ring-track { fill: var(--hud-bg) }`、`.note { background: var(--hud-bg) }` 直接用。`hud.background` 为 `null` 时取主题色 `var(--bg)`、`opacity` 取 1。

## 4. settings 变更（02 §3.0）

```
'hud.mode': HudMode                              // 默认 'peek'
'hud.displayId': number | null
'hud.position': { x: number | null; y: number | null }
'hud.background': string | null                  // 新增，默认 null = 跟随主题
'hud.opacity': number                            // 新增，默认 1，取值 0.3–1
'hud.autoHideFullscreen': boolean
```

删 `'hud.expanded'`。`SETTING_KEYS` 由 `DEFAULT_SETTINGS` 的 key 自动派生，不用另改；`hud.opacity` 的 0.3–1 范围在 guard 里校验（`app.setSetting` 的 schema 需要给这个 key 加约束，或在 `settingRepo.set` 里 clamp，二选一，说明你选了哪个）。

## 5. 渲染层

- `index.tsx`：`data.mode === 'note' ? <NoteWindow/> : <PeekBall/>`。
- `PeekBall`：进度环 + 待办角标 + 圆心 `no-drag` 点击热区（**drag 区收不到 click**，热区不能省）。
- `NoteWindow`：`.hud-head` 是 `drag` 把手（便签窗靠它拖），`.hud-list` / `.hud-add` 一律 `no-drag`；ESC 收成球。
- `HudPanel`：去掉 `variant` 与右上角 `⋯` 按钮；头部只剩 `● 3/5` 与 `今日 +N`。
- `useHudData`：删 `expanded`、`recentTitle`；`actions` 变成 `{ openNote, closeNote, completeRow, addTask }`。
- **文案纪律照旧**：面板上只允许 `● 3/5`、`今日 +N`、任务标题、`AppError.message` 原样。不写"暂无任务""点击展开"这类旁白。

## 6. 契约文本（原样替换进 docs）

### 6.1 `04-UI-SPEC.md` §5 整节替换

```
### ⑤ 悬浮窗（v0.21 重做）

窗口：透明、置顶、无边框、不进任务栏。尺寸与坐标**全部由主进程 `hudService` 决定**，
CSS 只负责画（`width/height: 100%`），不许用 CSS 改窗口大小。

两种形态，形态由**位置**决定，不是用户从菜单里选的：

| 形态 | 尺寸 | 位置 |
|---|---|---|
| `peek` 贴边球 | 56×56 | 贴屏幕**左或右**边缘，y 自由 |
| `note` 便签窗 | 360×min(480, 工作区高) | 自由位置，左右各留 ≥48 |

- 拖动中实时判定：球离边 >48px → 展开成便签窗；便签窗距边 ≤24px → 收成球。
  中间地带保持原形态（滞回，防抖）。
- 点球心热区 → 展开成便签窗；便签窗内 ESC → 收成球。
- 便签窗头部（`● 3/5` + `今日 +N` 那一行）是拖动把手，其余区域不可拖。
- 右键菜单三项：`背景颜色` / `透明度` / `关闭悬浮窗`。颜色与透明度即时生效并落
  `hud.background` / `hud.opacity` 两个 settings；关闭走 `hud.setVisible(false)`，
  之后从主窗顶栏开关再打开。
- 背景透明度只作用于**背景**，不作用于文字（用合成好的 rgba 写进 CSS 变量）。
- 已删除：贴屏幕顶、拉满全宽的 `dock-bar`；独立的"展开态"与 `hud.setExpanded` 通道。
```

### 6.2 `02-CONTRACTS.md` §3.0 的 AppSettings 段

把 `'hud.expanded': { 'dock-bar': boolean; 'float-pod': boolean }` 删掉，在 `'hud.position'` 后加两行：

```
'hud.background': string | null   // 新增 v0.21：null = 跟随主题色
'hud.opacity': number             // 新增 v0.21：0.3–1，默认 1
```

### 6.3 `02-CONTRACTS.md` §3.7b 的 hud 通道表

`hud.setExpanded` 一行删除，条数从 5 改为 4；`hud.getState` 的返回类型改为
`{ mode: HudMode; displayId: number; visible: boolean }`（**去掉 `expanded`**）。
`HudMode` 的定义改为 `'peek' | 'note'`。

## 7. 测试要求

必须新增/覆盖，缺一条不算交付：

1. `clampInto`：四边越界、宽高超出工作区（不产出负坐标）。
2. `edgeGap` / `nearEdge`：贴左、贴右、居中、同距取左边。
3. `peekBoundsFor`：贴左/贴右、y 上下越界被 clamp。
4. `noteBounds`：正常位置、太靠左被推到 48、太靠右被拉回、屏比 360+96 还窄时水平居中。
5. `noteRectFromPeek` ↔ `peekRectFromNote` 往返：**`noteRectFromPeek` 的结果必须 `edgeGap > 24`**（防死循环，见 §2.3）。
6. `resolveDragStep`：球 / 便签窗 × 贴边 / 中间 / 远三种距离，没到阈值时返回 `null`。
7. 状态机（假端口）：`attach` 后 `setBounds` 序列、拖球到中间 → 广播一次 `hud.mode.changed`、拖窗到边 → 收成球、回声不触发第二次切换。
8. `hud.setExpanded` 通道已不存在（清单断言里不能有它）。
9. 通道总数同步更新（现在是 36 条，删掉 `hud.setExpanded` 后 **35 条**；`tests/ipc/registry.test.ts` 里若有硬编码数字要一起改）。

## 8. 禁令

1. 不要动右栏、会话区、数据层（见 §1 的不许碰清单）。
2. 不要新增任何界面文案，包括右键菜单里除三项之外的条目、空状态文字、tooltip。
3. 不要恢复 `dock-bar`、不要保留兼容分支（"如果是 dock 就……"一律删干净）。
4. 不要在 CSS 里算透明度（`color-mix` / `opacity` 作用到容器都会让文字一起变淡）。
5. 不要把形态判定改成"松手才判"——用户明确要实时。真打断拖拽就写进报告，别自己改。
6. 不要为了通过测试而调 `EDGE_SNAP` / `EDGE_RELEASE` / `NOTE_EDGE_GAP` 的数值。
7. 提交用 `git commit <pathspec>` 带路径，**不要裸 `git commit`**（上一轮踩过：别的会话 staged 的文件被一起带走）。

## 9. 手点验收（交付时必须逐条说明结果）

1. 球贴在屏幕右边，能拖；拖离边缘超过约 48px → 自动变成便签窗。
2. 便签窗能靠头部拖动；拖到距边 24px 内 → 自动收成球，贴在那条边上。
3. 点球的圆心 → 展开成便签窗；便签窗里按 ESC → 收成球。
4. 球和便签窗上右键都能出菜单，三项都在；改颜色/透明度即时生效，**重启应用后保留**。
5. 右键 → `关闭悬浮窗` 后窗口消失；主窗顶栏那个开关能把它再打开。
6. 主窗勾一个每日任务，HUD 的 `● N/M` 在 100ms 内更新。
7. 重启后回到上次的形态与位置（球贴在原来那条边、便签窗在原来位置）。
8. 拔掉外接屏 / 改分辨率，HUD 不跑到屏幕外。

## 10. 自检表（贴进交付报告）

- [ ] `npm run typecheck` 零错
- [ ] `npm run lint` 零错（`--max-warnings 0`）
- [ ] `npm test` 全绿，条数写在报告里（起点 395）
- [ ] `npm run build` 通过
- [ ] `src/renderer/hud/DockBar.tsx` 已删除，全仓库搜不到 `dock-bar` / `float-pod` / `setExpanded`
- [ ] `git status` 干净，提交带 pathspec
- [ ] §9 八条手点结果逐条写明（跑不起来的项要如实说明是环境限制，不要含糊）
