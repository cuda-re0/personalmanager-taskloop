# 29 · 主窗顶栏 HUD 开关与主进程不同步（连点两次才生效）

基线：`a427162`（W9 v0.30 已审核 PASS）。单独跑，本单只碰 3 个源文件。

## 1. 现象（W9 验收时施工方自己报的，架构方已核实为真 bug）

1. 在 HUD 设置页点「关闭悬浮窗」→ 悬浮窗消失，但**主窗顶栏开关仍然显示"开"**。
2. 此时点主窗开关**第一次没反应**（其实是又关了一次），第二次才把悬浮窗打开。

## 2. 根因（已定位到行，不用再查）

`src/renderer/main/components/AppHeader.tsx`

- `useEffect` 只在挂载时调一次 `hud.getState()` 取初态（第 35–51 行），之后本地 `visible` 与主进程脱钩。
- 主进程 `hudService.setVisible()` 只改窗口，**不广播任何事件**；现有事件表里只有 `hud.mode.changed`，
  没有可见性事件。于是 HUD 自己关掉自己以后，主窗顶栏无从得知，本地仍是 `true`。

这不是 AppHeader 写错，是**少了一个事件**。本单补这个事件。

## 3. 改法（三处，照抄，不要自己发挥）

**(1) `src/shared/types/events.ts`** —— 在 `hud.mode.changed` 之后加一行：

```ts
  | { type: 'hud.visible.changed'; visible: boolean }
```

**(2) `src/main/services/hudService.ts`** —— `setVisible(visible: boolean)` 里，
在 `current.visible = visible` **之后**、`showInactive()/hide()` 之前，加：

```ts
broadcast({ type: 'hud.visible.changed', visible })
```

载荷必须是**目标值 `visible`**，不是 `win.isVisible()` 回读——回读在 show/hide 完成前是旧值，
取值会让开关闪一下再跳回来。用文件里已有的 `broadcast`，不要新增端口。

**(3) `src/renderer/main/components/AppHeader.tsx`** —— 在现有取初态的 `useEffect` **之外**
再加一个订阅（不要合并进去，初态与增量是两件事）：

```tsx
useEffect(() => {
  const off = window.api.onEvent(event => {
    if (event.type === 'hud.visible.changed') setVisible(event.visible)
  })
  return off
}, [])
```

注意：
- `window.api.onEvent` 是 `ipcRenderer.on` + `removeListener`，**支持多订阅**
  （`useTasksData` / `useCalendarData` / `usePointsData` 已在用），不会互相覆盖。
- 订阅回调里**只读**，不许回调 `setVisible({visible})` 写回主进程——那会自激。
- 现有 `toggle()` 的回弹逻辑（`setVisible(!next)`）保留不动。

## 4. 白名单

| 文件 | 动作 |
|---|---|
| src/shared/types/events.ts | 加 1 行事件类型 |
| src/main/services/hudService.ts | `setVisible` 里加 1 行 broadcast |
| src/renderer/main/components/AppHeader.tsx | 新增 1 个订阅 effect |
| tests/main/hudService.test.ts | 加 1 条断言：`setVisible(true/false)` 各广播一次 `hud.visible.changed`，载荷等于目标值 |
| tests/renderer/hudWiring.test.ts | 加 1 条结构断言：AppHeader 源码里有 `hud.visible.changed` 分支与 `return off` |

不许碰：`hudService` 的几何/状态机、`HudPanel`/`HudSettings`/`HudBall`、其它 `src/renderer/main/**`、
`src/main/ipc/**`、`docs/**`。通道条数不变（本单只加事件，不加通道）。

## 5. 验收（两条主路径，够用）

1. 开应用 → HUD 显示。在 HUD 设置页点「关闭悬浮窗」→ 悬浮窗消失，且**主窗开关在 1 秒内自己变成关**。
2. 点主窗开关**一次** → 悬浮窗出现、开关同步为开；再点一次 → 消失。全程没有"点两下才动"。

## 6. 自检（三行）

- [ ] 四命令绿（起点 48 文件 / 591 条）
- [ ] `git show --stat` 对照 §4，越界 0
- [ ] §5 两条实测结果（说清"几秒内同步"，别写"正常"）
