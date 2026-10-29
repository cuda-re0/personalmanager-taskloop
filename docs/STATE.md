# 现状一页纸

> 每次开工前只读这一页 + 你那一节的契约。历史沿革在 `kickoff/08-WAVE1-DELTA.md`，
> **不要从头读**——那是变更流水，只在"为什么这么定"说不清时才翻。
>
> 最后更新：2026-10-29，契约 **v0.22**。v0.21 修完用户手点报的 7 条问题（`cbf5eca`）；
> v0.22 补 W4 开工前的实测口径（`03 §9`：推理模型、`due_hint` 恒 null 的根因、60s 超时、key 三级优先级）。
> **从本轮起每项工程走三段**：交付 → 架构方审核 → **用户手点验收**，见 `kickoff/17-交付验收流程.md`。

## 一、进度

| 线 | 内容 | 状态 | 落点 |
|---|---|---|---|
| W0 | 脚手架 | ✅ | `e380896` 之前 |
| W1 | 数据层（表 / repo / service / 迁移 / 测试宿主） | ✅ 收工 | 末笔 `885058e`（rowid 全序微补丁） |
| W3 | 会话 UI（消息流 / 草稿卡 / 输入区） | ✅ 收工 | 末笔 `98ed377` |
| W11 | 附件存储（落盘 / 去重 / `app://attach` 协议） | ✅ 收工 | 末笔 `2cd3df6`（base64 预检补丁） |
| W2 | IPC 与事件总线（36 条通道 + bus + 测试） | ✅ 收工 | 末笔 `424e834` |
| W5 | 草稿 → 任务（promoteDraft 幂等 / 右栏①） | ✅ 收工 | 末笔 `32eb447` + `a8ebb93`（幂等零广播） |
| W6 | 完成与积分（`task.complete` / `task.undo` / 右栏③④） | ✅ 收工 | 末笔 `6e0ebbf`（补丁：24h 窗口 / result / 证据码） |
| W6B | 日历（红点 / 按日浮层 / focus-task） | ✅ 收工 | `949747e`（纯渲染层） |
| W9 | 悬浮窗（dock-bar / float-pod / 顶栏开关） | 🔁 **重做中**（用户否掉形态，见 `kickoff/15`） | `83ee042`，重做起点 `b88f334` |
| W4 | AI 接入（消息 → 草稿 / 审核 / health） | 🚧 **待开工**（开工词 `kickoff/16`，前置实测已完成） | — |
| W7 | 完成审核（含证据闸门，硬依赖 W4 的 `ai.review`） | 未开工 | — |
| W8 / W8B | 提醒 / 外部通知渠道 | 未开工 | — |
| W10 | 打包 | 未开工 | — |

## 二、基线（每次动手前后都该是这个数）

```
npm run typecheck   # 三段：node / web / test
npx eslint src tests --ext .ts,.tsx --max-warnings 0
npm test            # 33 文件 / 395 条（v0.21 起；v0.20 时是 392）
npm run build
```

## 三、几条不能违反的口径

1. **`pointsPlanned` 只有一个来源**：`daily → cfg.dailyBase`（传入值忽略），`deadline/event → computePlannedPoints(difficulty, cfg)`。卡面显示值必须等于落库值。
2. **默认难度 `medium`**，`01 §2.1` 的 `DEFAULT 'easy'` 只是 SQL 兜底。主进程对非法 `type × difficulty` 只拒绝、不归位；归位（`snapDifficulty`）是渲染层的事。
3. **`task.transition({to:'done'})` 一律 409**。不计分出口是 `task.complete({noPoints:true})`：写 `completed_at`、不写 ledger、`entry` 返回 `null`。
4. **落库后不可改类型**，`TaskPatch` 没有 `type`。`04 §3.2` 的"类型可就地改"只指草稿卡片。唯一例外是 `promoteDraft` 的 `TaskCreatePatch`（还带 `type`，因为确认本质是**创建**）——落库之后仍不可改。
5. **写操作必须广播事件**（02 §3.8）。`occurrence.today` / `listByRange` 内部会补行，也算写，必须广播 `occurrence.created`；`app.getBootstrap` 例外。
6. **界面文案必须先在 `04 §1.1` / §1.2 登记**，包括错误消息。没有登记的串不许写进代码。
7. **数值取整只允许 `roundPoints`**（`src/shared/points/rubric.ts`）；`Math.floor` 只许用于日期/天数换算，不得对分值本身取整（现有 4 处：月整除 1 处、逾期天数 3 处——逾期天数虽是 `penalty = overdueDays × 2` 的入参，但取整对象是天数不是分值，合规）。
8. **测试值不是真理**：`tests/` 里的期望值若与 `02` 的公式冲突，以 `02` 为准，并报给架构方。
9. **本地日历日只有一个实现**：`src/shared/localDay.ts`（v0.20 起主进程与渲染层共用）。不许再写 `toLocalDay` / `localDayOf` 的副本，更不许 `toISOString().slice(0,10)`——那是 UTC 日，东八区 00:00–08:00 会差一天。
10. **一个组件树里只许有一个 `useTasksData()`**：详情、分组都从 `TasksPanel` 拿 `actions`。多实例会让 `subtasksByParent` 为空、确认条永远弹不出来（v0.20 修，`tests/renderer/tasksPanelWiring.test.ts` 守着）。

## 四、还开着的缺口

| 缺口 | 卡住谁 | 记在哪 |
|---|---|---|
| `reminders` 表恒为空：`setReminderOffsets` 只写 offsets，不建行 | W8 的 `syncForTask` | 05 W2 · 已知缺口 |
| `DomainEvent` 没有 `reminder.updated` | W8 开工前必须补 | DELTA v0.12 |
| 改类型的语义（归位 / 清字段 / 重排提醒 / 补 occurrence） | 结论是"不做"，要改就是新需求 | 05 W5 |
| `Attachment.width/height` 恒 `null` | UI 不能靠尺寸占位 | 02 §3.3b |
| `app://attach` 真机时序未验 | W10 打包时手点一次 | 05 W11 验收 |
| `attachment.add` 的 handler 未注册（W11 只交了 service，`registry.ts` 是 W2 的文件） | 附件 UI 轮随 W2 补丁注册 | 05 W2 归属表 |
| `streakPreview` 的 `current` 入参无语义（service 不读） | 已在 02 §3.5 标废弃；删除动作（02 表 + `ipc.ts` + guards schema）随附件 UI 轮的 W2 补丁一起做 | 02 §3.5 |
| `hud.setVisible` 没有回向事件（`hud.visible.changed`） | **W8B 设置页要开关前必须先加**，否则两个入口各存一份状态 | 02 §3.7b |
| HUD 显隐不落 settings（重启复位为显示） | 有意为之：会话态；关掉后忘了怎么找回比"重启又出现"更糟 | 02 §3.7b |
| `noPoints` 完成的任务撤销没有 UI 入口（④ 是流水，无流水无行；① 只列未完成） | 通道可用、界面调不到；W10 打磨时若要补，先定位置 | 02 §3.2 |
| 悬浮条展开列表的行尾（`30min` / `10:00` / `+20`）未实现 | 只显示标题；要时间得联表、要分值得区分 awarded/planned | 04 §5.2 |
| 全屏自动隐藏未实现（纯 Electron 检测不可靠） | 只保留手动隐藏；W10 真机评估是否引入原生模块 | 04 §5.2、05 W9 验收 |

## 五、用户报过的问题 · 归属与状态（v0.22 盘点）

> 这张表是"谁欠谁的活"的唯一出处。新问题先进这里再派单。

| # | 问题（用户原话简化） | 归属 | 状态 | 落在哪 |
|---|---|---|---|---|
| 1 | 日历点不动 | W6B | ✅ `cbf5eca` | 任意日期可点，空日浮层留白；04 §4② 已改 |
| 2 | 每日任务一次出现 4 行 | W5 生产端 + W6 消费端 | ✅ `cbf5eca` | 广播收窄 + 三重 `day === today` 过滤 |
| 3 | 窗口缩小到最小布局塌 | W9（`windowManager`） | ✅ `cbf5eca` | `minWidth` 680 → 940 |
| 4 | 没有新建任务入口 | 架构方（04 §4① 缺口） | ✅ `cbf5eca` | 右栏① 顶部 `+` 就地表单 |
| 5 | 建任务没有任何条件可选 | **W4** | 🚧 待开工 | 草稿卡才是全字段编辑器；HUD 一句话建任务写死 `deadline/medium`，属设计 |
| 6 | 顶部条离不开顶（dock 横条） | **W9** | 🚧 待开工 | `kickoff/15` §0 决策 2：删掉 dock |
| 7 | 右上角 `⋯` 形态切换按钮太怪 | **W9** | 🚧 待开工 | `kickoff/15`：删按钮，形态由位置决定 |
| 8 | 收起后的球拖不动（只有外圈能拖） | **W9** | 🚧 待开工 | `kickoff/15` §2.4：拖动中实时判定 + 回声抑制 |
| 9 | 要能自己改背景颜色和透明度 | **W9** | 🚧 待开工 | `kickoff/15` §3：右键菜单 + 两个新 settings key |
| 10 | 要有关掉 HUD 的入口（"删除项"） | **W9** | 🚧 待开工 | `kickoff/15` §3 第三项 `关闭悬浮窗` |
| 11 | 看不到流水和撤销 | W6（已交付） | ✅ 数据在，入口在 ④ | 空态按 04 §7 留白，不写"暂无" |

**派单顺序建议**：先 W4，再 W9。理由不是优先级，是 `registry.ts` / `guards.ts` 两个文件两边都要动（W4 加 6 条、W9 删 1 条），并行容易再次出现"提交踩踏"。

## 六、文档怎么用

| 想知道 | 看 |
|---|---|
| 表结构、列约束 | `01-DATA-MODEL.md` |
| 类型、IPC 方法、事件、错误码 | `02-CONTRACTS.md` |
| AI 的输入输出与降级 | `03-AI-CONTRACT.md` |
| 界面文案、布局、状态名 | `04-UI-SPEC.md` |
| 每条线的授权目录与验收 | `05-BACKLOG.md` |
| 为什么这么定（变更流水） | `kickoff/08-WAVE1-DELTA.md` |
