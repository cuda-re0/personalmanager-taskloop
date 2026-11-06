**你是施工方，不是架构方。下面这份是给你的执行指令，直接照它改代码。**

---

# 77 · 本机 MCP 数据接口（只读）

## 背景（一句话）

外部 AI（朋友的 dsh）要读 taskloop 的任务、积分、聊天。做法是在本机起一个 MCP 服务，走 HTTP transport，只读，不碰现有行为。

## 执行须知（施工方必读）

1. 你是施工方，不是架构方。本文档是执行指令，读完直接改代码；不要重写/扩写本单，不要新建 `docs/kickoff/*`，不要先产出“实施方案/评审意见”。
2. 本单**只读**。不许实现写操作（发消息、建任务、打卡），那些在 78 单。不许改任何现有业务行为——AI 照常回复、提醒照常弹。
3. 只碰 A 节白名单的 6 个文件。**不要动**渲染层（`src/renderer/**`）、不要动 `AppSettings` / `defaultSettings` / `guards`。
4. 交付只贴 `git diff --stat` + 自检结果 + 未能自验的条目。
5. 本单占版本号 **0.74.0**（76 占 0.73.0，71 顺延 0.75.0）。

## A 文件白名单（6 个）

**A1. 新建 `src/main/mcp/token.ts`**

- `readOrCreateToken(): string | null`
- 文件固定为 `join(app.getPath('userData'), 'mcp-token.txt')`
- 已存在且 trim 后非空 → 直接返回（不要重新生成，否则每次启动 dsh 那边都得改配置）
- 不存在 → `crypto.randomBytes(16).toString('hex')` 生成，写入（`mode: 0o600`），返回
- 任何异常返回 `null`，**不抛**
- 这个文件**不许**进入打包产物，也不许写进任何配置或日志

**A2. 新建 `src/main/mcp/tools.ts`**

- 导出工具定义数组与执行函数，形状按 MCP 的 `tools/list` / `tools/call` 要求
- 所有工具**只读**，执行时不得写库、不得触发 AI、不得发通知
- 五个工具，名字与入参写死在 B 节

**A3. 新建 `src/main/mcp/server.ts`**

- `startMcpServer(port: number): Promise<{ port: number; close: () => Promise<void> }>`
- 用 `node:http`，**不引任何新依赖**（不许装 MCP SDK，打包链路只认现有 node_modules）
- 只监听 `127.0.0.1`，不许 `0.0.0.0`
- 只处理 `POST /mcp`：
  - 缺 `Authorization` 或不是 `Bearer <token>` → `401`，body 为空对象
  - `Content-Type` 必须是 `application/json`，否则 `415`
  - 解析失败 → JSON-RPC 错误码 `-32700`
- JSON-RPC 2.0 分发，支持四个方法：
  - `initialize` → 返回 `protocolVersion: "2025-06-18"`、`capabilities: { tools: {} }`、`serverInfo: { name: "taskloop", version: <package version> }`
  - `notifications/initialized` → `202`，无 body
  - `tools/list` → A2 的定义
  - `tools/call` → `{ name, arguments }`，结果包成 `content: [{ type: 'text', text: <JSON 字符串> }]`；工具内部抛错时返回 `isError: true` 且 text 是错误消息（中文一句话，不带堆栈）
  - `ping` → `{}`
  - 其余方法 → 错误码 `-32601`
- 每次响应都带 `jsonrpc: "2.0"` 和请求的 `id`（通知类无 `id`）
- 端口被占用时：`console.warn` 一句后 **resolve 一个 no-op 的 close**，不许抛、不许导致启动失败
- 无状态：不实现 session、不做 SSE、不主动推送

**A4. 新建 `src/main/mcp/index.ts`**

- 导出 `startMcp()`：读 token（null 则跳过启动并 warn）、`startMcpServer(MCP_PORT)`、把 close 存进模块变量
- 导出 `stopMcp()`
- `export const MCP_PORT = 17321`

**A5. `src/main/index.ts`**

- `whenReady` 里 `initDb()` 之后调 `void startMcp()`（不 await，失败静默）
- `before-quit`（或现有退出清理处）调 `stopMcp()`
- 不许改动其他任何启动顺序

**A6. `package.json`**：`version` → `0.74.0`

## B 五个工具（名字与入参写死）

统一要求：返回值一律是可 `JSON.stringify` 的普通对象；时间用 ISO 字符串；**不要**返回 `detailMd` 全文（可能几千字），详情走 `get_task`。

**B1. `get_overview`** — 无入参
```
{ now, today, pendingTasks, todayOccurrences, points: { today, week, month } }
```
- `today` 是本地日 `YYYY-MM-DD`，`now` 是本地 ISO 带时区偏移
- 统计口径复用现成服务（`taskService` / `pointsService`），不许在工具里重写一遍算分逻辑

**B2. `list_tasks`** — 入参 `{ scope?: 'active' | 'today' | 'all', limit?: number }`，默认 `active`、`limit` 50（上限 100）
- `active`：未完成任务（不含 done / missed），按现有 `compareTasks` 排序
- `today`：今日 occurrence 对应的任务
- `all`：全部顶层任务
- 每项字段：`id, title, type, status, priority, dueAt, parentId, remaining, steps: { done, total }`
- 不含 `detailMd`

**B3. `get_task`** — 入参 `{ id: string }`
- 返回完整任务 + 子步骤数组（每项 `id, title, status`）+ `requiresEvidence`
- 任务不存在 → 抛错，由 A3 转成 `isError`
- 可以含 `detailMd`（这是详情接口）

**B4. `list_messages`** — 入参 `{ since?: string, limit?: number }`，默认 `limit` 30（上限 100）
- `since` 传消息 id：用现有的「取某条之后」查询，返回更晚的消息（升序）
- 不传 `since`：返回最近 `limit` 条（升序）
- 每项：`id, role, text, mode, createdAt`
- 只返回 `text` 类内容；附件只给 `attachments: number` 计数，不给二进制

**B5. `get_points`** — 入参 `{ range?: 'today' | 'week' | 'month' }`，默认 `today`
- 返回 `{ range, total, items: [{ at, delta, reason, taskId }] }`
- 口径必须复用 `pointsService` 现成函数，不许另写 SQL

## C 测试（两个新文件）

**C1. `tests/main/mcpServer.test.ts`**（不碰 db，token 用假值）
- 起在 `port: 0`（随机端口），用 `fetch` 打：
  - 无 token → 401
  - `initialize` → 有 `protocolVersion` 与 `serverInfo.name === 'taskloop'`
  - `tools/list` → 长度 5，名字齐全
  - 未知方法 → `-32601`
  - 坏 JSON → `-32700`
- 测完 `close()`，不许留端口

**C2. `tests/main/mcpTools.test.ts`**（用 `:memory:` 库 + 现有造数方式）
- `list_tasks` 返回造出来的任务，字段齐全
- `get_task` 对不存在的 id 抛错
- `list_messages` 的 `since` 只返回更晚的消息（造三条，从第二条之后取，应得第三条）

## D 验收（三条）

1. 启动应用后 `curl -X POST http://127.0.0.1:17321/mcp -H "Authorization: Bearer <mcp-token.txt 里的值>" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` 能拿到 5 个工具。
2. 同一个 curl 换成 `tools/call` + `list_tasks`，能拿到真实任务标题。
3. 去掉 Authorization 头 → 401；`npm run typecheck` / `lint` 全绿；`npm test` 除 `chatBrief.test.ts:74` 那条历史红外全过。

## E 交付记录（架构方复核，2026-11-06）

**落地文件**：新增 `src/main/mcp/{token,tools,server,index}.ts`（共约 514 行）、`tests/main/{mcpServer,mcpTools}.test.ts`（8 条断言）；改 `src/main/index.ts`（+3 行接线）、`package.json`（0.74.0）。

**复核结论：通过。** 逐条核对：
- `token.ts`：路径 `userData/mcp-token.txt`、已存在则复用、`mode: 0o600`、异常返回 `null` 不抛 —— 全对。
- `server.ts`：只 `listen(port, '127.0.0.1')`；`POST /mcp` 之外一律 404；401 / 415 / `-32700` / `-32601` 分支齐全；`initialize` 返回 `2025-06-18`；端口占用走 `once('error')` → resolve no-op，不抛。`tools/call` 抛错转 `isError: true` + 单行中文消息，不漏堆栈。
- `tools.ts`：五个工具名与入参照单；`get_overview.todayOccurrences` 与 `list_tasks(scope=today)` 都走 `listRangeRaw()`，**全程无写库**（避开 `listToday()` 的 `ensureRange` 写操作）；排序直接用渲染层 `compareTasks`（纯函数，只依赖 `@shared/*`），没复制排序逻辑。
- `index.ts`：`startMcp` 在 `initDb()` 之后 `void` 调用，`before-quit` 调 `stopMcp()`，其余启动顺序未动。

**自检（架构方独立复跑）**：`typecheck` 0 error、`lint` 0 warning、`npm test` 75 文件 / 832 条（831 passed，唯一红 `chatBrief.test.ts:74`）、`npm run build` 成功（主进程产物含 `17321` / `mcp-token.txt` / `tools/list`）、`npm run pack` → `updates/latest.json` = **0.74.0**，包内无任何 `mcp-token*` 文件。

**未验证**：D1 / D2 的「真实进程 + 固定端口」一条。当前运行中的绿色版是 0.73.0（端口未监听、token 未生成），需重启一次由自检覆盖到 0.74.0 后才能 curl。

**已知取舍（记录在案，不是缺陷）**：
1. `compareTasks` 位于渲染层，主进程反向 import 它属于跨层引用。好处是排序口径唯一，坏处是主进程产物被打进渲染层纯模型。若日后该文件引入 React 依赖，主进程构建会挂——届时再把排序下沉到 `@shared/`。
2. token 只保护「知道 token 的本机进程」，不防同机同用户的其他程序读取 `userData`。这是本机接口的固有边界，文档里已注明。
3. MCP 服务对所有使用者默认开启，包括将来收到绿色版的朋友。是否加设置开关，留待用户裁决。
