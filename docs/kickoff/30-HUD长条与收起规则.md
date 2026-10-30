# 30 · HUD v0.31：长条化 + 出屏 1/3 才收起 + 关掉后能重新打开

基线：`bfbc5e3`（W9 v0.30 已审核 PASS，`a427162`）。**单独跑，不要与任何会话并行**（动 hudService 几何 + 主窗 AppHeader）。

> **本单合并了 `kickoff/29`**（顶栏开关连点两次才生效）。29 号不要再单独派发——两个会话同时改 `hudService.ts` 会互相踩。
> 如果 29 已经派出去了，让那个会话停下、改用本单。

## 0. 用户裁决（原话，不要再问）

1. 「悬浮窗关闭后，要能重新打开」
2. 「悬浮窗在边侧超过 1/3 超出桌面时，才自动收起」
3. 「圆形换成小长条，里面左侧是一个小圆圈，要能表示已完成任务数量比，就和现在这个圈一样。紧贴着右边就是已完成任务数/任务总数，最右边就是星期」

## 1. 长条（替代 v0.30 的 56×56 圆球）

### 1.1 尺寸与常量

`src/main/services/hudService.ts`：

```
BALL_SIZE（删掉，或改为下面两个常量，全仓 BALL_SIZE 引用点必须清零）
BALL_W = 132
BALL_H = 40
```

- 形态值仍是 `'ball'`（不改成 `'bar'`）：`hud.mode` 存的是形态标识，改值域要动旧库归一与契约，
  视觉改名不值得。在常量处写一句注释「形态值仍为 ball，v0.31 起视觉是长条」。
- 所有原 `BALL_SIZE` 的用处（`clampBallPoint` / `initialBallPoint` / `ballBounds` /
  `peekPanelBounds` 的水平基准 / `moveTo` 里的宽高）改为 `BALL_W` / `BALL_H`。
- `peekPanelBounds` 里原本用 `ball.x + BALL_SIZE / 2` 判左右半屏 → 改 `ball.x + BALL_W / 2`。

### 1.2 长条内部（`HudBall.tsx` + `hud.css`）

DOM（自上而下）：

```tsx
<div className="hud-ball" style={{ '--hud-bg': data.hudBg }}>
  <span className="hud-bar-ring">            {/* 20×20 进度环 */}
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" className="hud-bar-track" />
      <circle cx="10" cy="10" r="8" className="hud-bar-value"
              strokeDasharray={`${ratio*C} ${C}`} transform="rotate(-90 10 10)" />
    </svg>
  </span>
  <span className="hud-bar-ratio">{ratioLabel(data.done, data.total)}</span>
  <span className="hud-bar-week">{weekdayLabel(new Date())}</span>
  <button type="button" className="hud-hit" onClick={() => setMode('panel')} aria-label="展开悬浮窗" />
</div>
```

- `C = 2 * Math.PI * 8`，`ratio = completionRatio(done, total)`（复用现有函数，`total=0` 返回 0）。
- 环颜色：轨道 `--line`（或现有等价变量），进度 `--accent`；环宽 `2.5px`。
- `.hud-ball`：`width/height: 100%`、`border-radius: 999px`、`background: var(--hud-bg)`、
  `display: flex; align-items: center; gap: 6px; padding: 0 10px;`
  `-webkit-app-region: drag;`（整条可拖），`overflow: hidden`。
- 文字：`font-size: 12px`、`font-variant-numeric: tabular-nums`、`.hud-bar-week { color: var(--text-dim) }`
  （若没有 dim 变量就同用 `--text`，不要新造变量）。
- **点击热区 `.hud-hit`**：绝对定位覆盖整个长条（`inset: 0`）、`-webkit-app-region: no-drag`、
  透明、`cursor: pointer`。`drag` 区收不到 click，没有这块就点不开。
  左右内边距不参与拖动也无所谓——整条都能拖不是必须，能点开才是。

### 1.3 星期（`hudModel.ts`）

```ts
const WEEKDAYS = ['周日','周一','周二','周三','周四','周五','周六'] as const
export function weekdayLabel(date: Date): string { return WEEKDAYS[date.getDay()] }
```

硬编码，不用 `toLocaleDateString('zh-CN', {weekday})`（依赖 ICU，打包环境可能不一致）。

## 2. 收起规则：出屏 > 自身宽度 1/3 才收（替代「距边 ≤24px 就收」）

### 2.1 判定（`resolveDragStep` 重写面板分支）

```ts
export const PANEL_COLLAPSE_RATIO = 1 / 3

/** 左/右各出屏多少（正值 = 露在屏幕外的宽度） */
export function offscreenOf(workArea: Rect, rect: Rect): { left: number; right: number } {
  return {
    left:  Math.max(0, workArea.x - rect.x),
    right: Math.max(0, rect.x + rect.width - (workArea.x + workArea.width))
  }
}

// 面板态：
//   const { left, right } = offscreenOf(workArea, rect)
//   const limit = rect.width * PANEL_COLLAPSE_RATIO
//   if (left  > limit && left  >= right) return 'collapse-left'
//   if (right > limit)                    return 'collapse-right'
//   return 'none'
```

- **长条态不变**：`gap > EDGE_EXPAND(48)` → `expand`。`edgeGap` 函数保留（长条在用）。
- 面板态**不再看 `edgeGap`**——「距边 ≤24px 收球」整条作废，`EDGE_COLLAPSE` 常量如果没人用了就删（grep 确认）。

**v0.31 补充裁决（施工方提问后定，原规格漏写）**：`EDGE_COLLAPSE(24)` 与 `PEEK_GAP(=EDGE_COLLAPSE+1)`
**连同 `peekPanelBounds` 里那两行防自锁特判一起删掉**，不是保留。

理由：那条特判存在的唯一目的是「展开后别贴边，否则距边 ≤24 会立刻把面板收回去（自锁）」。
新规则下收起看的是**出屏 > 宽 1/3**，而 `peekPanelBounds` 末尾有 `clampInto` 保证面板完全在屏内
（出屏 = 0 ≤ 1/3）→ 永远不会自激。保留特判反而有害：贴右展开时面板会被推离边缘 `PEEK_GAP=25px`，
用户看到窗口横跳一下。

删掉后：`edgeGap` 仅剩长条态在用，`EDGE_EXPAND` 保留，`EDGE_COLLAPSE` / `PEEK_GAP` 全仓 0 引用（§7 自检会 grep）。
- 收球贴边沿用现有 `ballFromPanel(workArea, rect, side)`：`side` 由上面返回的 `collapse-left/right` 决定。

### 2.2 允许面板出屏（≤1/3），不要推回屏内

`boundsFor` 的 panel 分支现在是 `clampInto(workArea, ...)`——**必须改**，否则拖出去松手会被弹回来，
用户就看不到「1/3 以内保持不动」这个行为了：

```ts
// 面板：纵向 clamp 进工作区，横向按原值（出屏 >1/3 的情况已在判形态时收球，走不到这里）
function panelBounds(workArea: Rect, size: HudSize, point: Point): Rect {
  const full = clampInto(workArea, { ...point, width: size.width, height: size.height })
  return { x: Math.round(point.x), y: full.y, width: full.width, height: full.height }
}
```

`ballBounds` 不变（长条自身仍完全 clamp 进工作区）。

### 2.3 `settle()` 里也要判一次

`judgeShape` 是 `move` 事件 `120ms` 去抖——用户快速拖出去立刻松手可能不到 120ms，
这时 `settle` 会先把位置落库、形态却没变。所以 `settle()` 开头（取到 `rect` 与 `area` 之后）先判一次：

```
const step = resolveDragStep(state.mode, area.workArea, rect)
if (step === 'expand')  → enterMode('panel', ...) 后 return
if (step.startsWith('collapse')) → enterMode('ball', ...) 后 return
```

`enterMode` 内部已经 `persistPosition` / `broadcast`，不要重复落库。

## 3. 关掉后能重新打开（原 `kickoff/29`）

### 3.1 现象

HUD 设置页点「关闭悬浮窗」→ 悬浮窗消失，但主窗顶栏开关仍显示"开"；点它**第一次没反应**，第二次才打开。

### 3.2 根因（已定位，不用再查）

`AppHeader` 只在挂载时 `hud.getState()` 取一次初态，之后本地 `visible` 与主进程脱钩；
而 `hudService.setVisible()` 只改窗口、**不广播事件**，事件表里只有 `hud.mode.changed`。

### 3.3 改法

**(1) `src/shared/types/events.ts`** —— `hud.mode.changed` 之后加一行：

```ts
  | { type: 'hud.visible.changed'; visible: boolean }
```

**(2) `hudService.setVisible()`** —— `current.visible = visible` 之后、`showInactive()/hide()` 之前：

```ts
broadcast({ type: 'hud.visible.changed', visible })
```

载荷是**目标值**，不是 `win.isVisible()` 回读（回读在 show/hide 完成前是旧值，开关会闪一下）。

**(3) `AppHeader.tsx`** —— 在现有取初态的 `useEffect` **之外**再加一个：

```tsx
useEffect(() => {
  const off = window.api.onEvent(event => {
    if (event.type === 'hud.visible.changed') setVisible(event.visible)
  })
  return off
}, [])
```

- `window.api.onEvent` 是 `ipcRenderer.on` + `removeListener`，支持多订阅，不会覆盖其他 hook。
- 回调里**只读**，不许回调 `setVisible({visible})` 写回主进程（会自激）。
- 现有 `toggle()` 的回弹逻辑保留。

## 4. 白名单

| 文件 | 动作 |
|---|---|
| src/shared/types/events.ts | 加 1 行 `hud.visible.changed` |
| src/main/services/hudService.ts | 常量拆 BALL_W/BALL_H、`offscreenOf`、`resolveDragStep` 面板分支重写、`panelBounds`、`settle` 先判形态、`setVisible` 加 broadcast |
| src/main/windowManager.ts | **可不动**（施工方核实：建窗尺寸来自 `resolveInitialBounds`、本来就没写 min/max）。只有当注释里写着「56×56 圆球」这类过时描述时才顺带更正——**仅注释，零逻辑改动** |
| src/renderer/main/components/AppHeader.tsx | 新增订阅 effect |
| src/renderer/hud/HudBall.tsx | 改为长条（环 + 比例 + 星期 + 热区） |
| src/renderer/hud/hud.css | `.hud-ball` 胶囊化、环/文字/热区样式 |
| src/renderer/hud/hudModel.ts | 加 `weekdayLabel` |
| tests/main/hudService.test.ts | 见 §5 |
| tests/renderer/hudModel.test.ts | `weekdayLabel` 7 天全覆盖 |
| tests/renderer/hudWiring.test.ts | 见 §5 |

不许碰：`HudPanel.tsx` / `HudSettings.tsx` / `useHudData.ts` / `src/main/ipc/**` / 其它 `src/renderer/main/**`、
`src/main/db/**`、`docs/**`。通道条数不变（本单只加事件）。

## 5. 测试（锁行为，不逐像素）

**hudService.test.ts**

1. `initialBallPoint`：`x = workArea.right − 132`、`y = round(height × 0.1)`。
2. `clampBallPoint`：长条不出屏（x 夹在 `[workArea.x, workArea.right − 132]`）。
3. `resolveDragStep` 面板态四个用例：
   - 出屏 0 → `none`
   - 右侧出屏恰为 `width/3` → `none`（边界取「超过才收」）
   - 右侧出屏 `width/3 + 1` → `collapse-right`
   - 左侧出屏 `width/3 + 1` → `collapse-left`
4. 长条态仍按 `gap>48` 判 `expand`。
5. `panelBounds`（或 `boundsFor` panel 分支）：`x` 允许为负 / 超出工作区右边界，`y` 仍被夹。
6. `setVisible(true/false)` 各广播一次 `hud.visible.changed`，载荷等于目标值。

**hudModel.test.ts**：`weekdayLabel` 对 7 个已知日期给出 `周日`…`周六`。

**hudWiring.test.ts**：`HudBall.tsx` 里有 `hud-bar-ring` / `hud-bar-ratio` / `hud-bar-week` / `hud-hit`；
源码里搜不到 `BALL_SIZE`；`AppHeader.tsx` 有 `hud.visible.changed` 分支与 `return off`。

### 5.1 旧断言怎么改（授权改 `tests/main/hudService.test.ts` 全部相关断言）

测试基线工作区是 `1920 × 1040`（`availTop = 0`）。改后应写成：

| 旧断言 | 新值 |
|---|---|
| `initialBallPoint` → `{x:1864, y:104}` | `{x:1788, y:104}`（`1920 − 132`） |
| `ballBounds` → `{x:1864,y:104,w:56,h:56}` | `{x:1788,y:104,w:132,h:40}` |
| `clampBallPoint(wa,{x:9999,y:9999})` → `{x:1864,y:984}` | `{x:1788,y:1000}`（`1040 − 40`） |
| `clampBallPoint(wa,{x:-100,y:-100})` → `{0,0}` | 不变 |
| `peekPanelBounds`（球在右边缘 `x:1864`）→ `1920−360−25` | 球的 x 改 `1788`，结果 `x:1560`（`1788+132−360`，**不再减 PEEK_GAP**） |
| `peekPanelBounds`（球在 `x:100`）→ `{x:100,...}` | 不变（左半屏向右长） |
| 「展开落点必留 > 24 边距」整条（`edgeGap > EDGE_COLLAPSE` 循环） | **删掉，换成**：`peekPanelBounds` 结果经 `offscreenOf(wa, rect)` 断言 `left === 0 && right === 0`（展开后面板完全在屏内 → 不会触发 >1/3 收起） |
| `ballFromPanel(..., 'left'/'right')` 的期望 x | 左 `0` 不变；右 `1920 − 132 = 1788` |

其余与 56 无关的用例保持原样。**不要为了让旧断言过而保留旧常量**——数改了就是在改契约。

## 6. 验收（三条主路径）

1. **长条**：清掉 `hud.position`/`hud.size` 重启 → 长条 132×40、贴右边缘、距顶约 10%；
   左侧环的填充比例与 `N/M` 一致，最右是当天星期（今天应是 `周五`）。点它 → 打开面板。
2. **收起规则**：把面板往右拖出屏幕一点（约 1/4）松手 → 停在原地、**不收起**；
   继续拖到超过 1/3 宽 → 当场变成长条并贴右边。长条拖离右边 >48px → 又展开成面板。
3. **关掉重开**：设置页点「关闭悬浮窗」→ 悬浮窗消失、主窗顶栏开关**1 秒内自己变关**；
   点该开关**一次** → 悬浮窗出现、开关同步为开。

## 7. 自检（三行）

- [ ] 四命令绿（起点 48 文件 / 591 条）
- [ ] `git show --stat` 对照 §4，越界 0；全仓 `grep -rn "BALL_SIZE\|PEEK_GAP\|EDGE_COLLAPSE" src tests` 0 命中
- [ ] §6 三条实测（写清"出屏几 px 收起""几秒内同步"，别写"正常"）
