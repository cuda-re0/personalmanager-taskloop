# W2 · IPC 与事件总线（开工词）

> 第 1 波，可与 W1 / W3 / W4 / W6B-UI / W9-UI 同时开工。

---

## 你是

`taskloop` 的 IPC 与事件总线实现方。你是**主进程和两个渲染进程之间唯一的通道**。你定下的 `window.api` 形状，就是 W3、W6B、W9 三个界面的编程接口。

**项目根目录**：`C:\Users\shuiliang\WorkBuddy\任务管理审核`

## 先读这些

- `docs/02-CONTRACTS.md` 的 §2（IPC 方法表，逐条对着建）、§3（入参出参）、§4（`window.api` 的完整形状）、§5（DomainEvent 全部类型）
- `docs/00-ARCHITECTURE.md` 的 §2 不变量（尤其"主进程是唯一写库者"）
- `docs/05-BACKLOG.md` 的 `W2` 段

## 你能改的目录

```
src/main/ipc/**
src/main/bus.ts
src/preload/index.ts
```

**不许改**：`src/shared/**`（类型已由 W0 定好，照用）、`src/main/db/**`（W1 的地盘）、`src/main/ai/**`（W4 的地盘）、`src/renderer/**`、`src/main/index.ts`（W0 已预留好 `registerIpcHandlers()`，你只填这个函数的实现）。

## 交付

### 1. `bus.ts`

```ts
export function broadcast(event: DomainEvent): void
```

向所有**存活**的 window 逐个 `webContents.send('bus:event', event)`。

两条硬要求：

- 发之前判 `!win.isDestroyed() && !win.webContents.isDestroyed()`。HUD 被关掉后再广播不能抛异常（这条有验收）
- 一个窗口发失败不能中断向其他窗口广播（每个 `send` 独立 try/catch）

### 2. `registerHandlers.ts`

按 `02-CONTRACTS.md` §3 的表格，把 `task.* / msg.* / ai.* / points.* / reminder.* / calendar.* / occurrence.* / hud.* / app.*` 全部注册。

统一封装：

```ts
function handle<I, O>(channel: string, fn: (input: I) => O | Promise<O>): void
```

行为：

- `fn` 抛 `AppError` → 原样返回它的 code
- `fn` 抛未知异常 → 转成 `{ code: 'UNKNOWN', message }`，并 `console.error` 打完整堆栈（主进程日志，不要发给渲染层）
- **永远不 throw 到 ipcMain 外面**。渲染层收到的一定是 `{ok:true,data}` 或 `{ok:false,error}`，不是异常

### 3. `guards.ts`

每个通道的入参用 zod 校验。校验失败返回 `INVALID_INPUT`，**不许**让非法入参进到 service 层（W1 的代码不加防御，靠你挡）。

### 4. preload

按 `02-CONTRACTS.md` §4 暴露 `window.api`。

```ts
contextBridge.exposeInMainWorld('api', { app, task, msg, ai, points, reminder, calendar, hud, onEvent })
```

`onEvent(cb)` 必须**返回取消订阅函数**，并且在 `window` 卸载时自动清理（否则窗口关了还在收事件，DevTools 里会看到内存增长）。

`contextIsolation: true`、`nodeIntegration: false`，不许为了省事关掉。

### 5. 类型打通

`Api` 类型在 `src/shared/types/ipc.ts`（W0 已建）导出。preload 与渲染层 import 同一个类型。

渲染层要能这样写且不报红：

```ts
const boot = await window.api.app.getBootstrap()
```

## 本轮的数据怎么办（重要）

W1 正在同时写数据层，**你开工时 `src/main/services/` 大概率还是空的甚至不存在**。

所以：

- **不要在 handler 里 import `taskService` 等文件** —— 文件不存在会编译失败，你会被迫去建一个属于 W1 的文件，那就是冲突
- 正确做法：handler 里**先返回一个符合类型的最小假数据**，并标注 `// TODO(W1): 换成 taskService 调用`
- 你的验收（"HUD 能收到事件"）用这些假数据就能完成
- 等 W1 落地后，只需把 TODO 处换成真实调用，`window.api` 的形状一行都不用改

这样你和 W1 完全解耦，谁先完成都不影响对方。

## 验收

- [ ] 主窗调 `api.app.getBootstrap` 拿到正确形状（数据可全空，但字段一个不少）
- [ ] 主窗调 `task.createManual` → HUD 通过 `onEvent` 收到 `task.created`，HUD 页面显示该标题
- [ ] 传错误类型参数（如 `{ id: 123 }` 期望 string）→ 返回 `{ok:false, error:{code:'INVALID_INPUT'}}`，**不抛异常、不白屏**
- [ ] 关闭 HUD 后再广播事件 → 不报错、主进程不崩
- [ ] `onEvent` 返回的取消函数调用后，不再收到事件
- [ ] 窗口关闭后 `onEvent` 的监听被清理（在 DevTools 里验证监听器数量不增长）
- [ ] 渲染层全局搜索 `require('electron')` → 零结果
- [ ] 渲染层全局搜索 `better-sqlite3` / `db.prepare` → 零结果

## 禁止

- 渲染层不许出现 `require('electron')` 或 `import { ipcRenderer }`，一律走 `window.api`
- handler 里不许直接写 SQL，必须走 service
- 不许改 `src/shared/types/ipc.ts` 的接口形状。觉得某个方法入参不够用，停下来报告
- 不许在 handler 里做业务计算（积分、状态机、日期推算都在 service / rubric 里）

## 交付时附给我

1. 验收清单逐条结果（✅ / ❌ + 原因）
2. 一份 `window.api` 的完整方法列表截图或代码，我核对是否与 02 §4 一致
3. 哪些 handler 里留了 `// TODO(W1)`（我需要知道 W1 落地后要回来改哪几处）
4. `git status` 原文
