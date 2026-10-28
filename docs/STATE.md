# 现状一页纸

> 每次开工前只读这一页 + 你那一节的契约。历史沿革在 `kickoff/08-WAVE1-DELTA.md`，
> **不要从头读**——那是变更流水，只在"为什么这么定"说不清时才翻。
>
> 最后更新：2026-10-28，契约 `contract-v0.13`。

## 一、进度

| 线 | 内容 | 状态 | 落点 |
|---|---|---|---|
| W0 | 脚手架 | ✅ | `e380896` 之前 |
| W1 | 数据层（表 / repo / service / 迁移 / 测试宿主） | ✅ 收工 | 六个提交，末笔 `423dc46` |
| W3 | 会话 UI（消息流 / 草稿卡 / 输入区） | ✅ 收工 | 末笔 `98ed377` |
| W11 | 附件存储（落盘 / 去重 / `app://attach` 协议） | ✅ 收工 | 末笔 `eb6b0e3` |
| W2 | IPC 与事件总线（25 条通道 + bus + 测试） | ✅ | `ea503a5` |
| W4 | AI 接入 | 未开工 | — |
| W5 | 草稿 → 任务 | 未开工 | — |
| W6 / W6B | 完成与积分 / 日历 | 未开工 | — |
| W8 | 提醒 | 未开工 | — |
| W9 | 通知渠道 + 悬浮窗 | 未开工 | — |
| W10 | 打包 | 未开工 | — |

## 二、基线（每次动手前后都该是这个数）

```
npm run typecheck   # 三段：node / web / test
npx eslint src tests --ext .ts,.tsx --max-warnings 0
npm test            # 20 文件 / 234 条
npm run build
```

## 三、几条不能违反的口径

1. **`pointsPlanned` 只有一个来源**：`daily → cfg.dailyBase`（传入值忽略），`deadline/event → computePlannedPoints(difficulty, cfg)`。卡面显示值必须等于落库值。
2. **默认难度 `medium`**，`01 §2.1` 的 `DEFAULT 'easy'` 只是 SQL 兜底。主进程对非法 `type × difficulty` 只拒绝、不归位；归位（`snapDifficulty`）是渲染层的事。
3. **`task.transition({to:'done'})` 一律 409**。不计分出口是 `task.complete({noPoints:true})`：写 `completed_at`、不写 ledger、`entry` 返回 `null`。
4. **落库后不可改类型**，`TaskPatch` 没有 `type`。`04 §3.2` 的"类型可就地改"只指草稿卡片。
5. **写操作必须广播事件**（02 §3.8）。`occurrence.today` / `listByRange` 内部会补行，也算写，必须广播 `occurrence.created`；`app.getBootstrap` 例外。
6. **界面文案必须先在 `04 §1.1` / §1.2 登记**，包括错误消息。没有登记的串不许写进代码。
7. **数值取整只允许 `roundPoints`**（`src/shared/points/rubric.ts`）；全仓唯一的 `Math.floor` 在逾期天数。
8. **测试值不是真理**：`tests/` 里的期望值若与 `02` 的公式冲突，以 `02` 为准，并报给架构方。

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

## 五、文档怎么用

| 想知道 | 看 |
|---|---|
| 表结构、列约束 | `01-DATA-MODEL.md` |
| 类型、IPC 方法、事件、错误码 | `02-CONTRACTS.md` |
| AI 的输入输出与降级 | `03-AI-CONTRACT.md` |
| 界面文案、布局、状态名 | `04-UI-SPEC.md` |
| 每条线的授权目录与验收 | `05-BACKLOG.md` |
| 为什么这么定（变更流水） | `kickoff/08-WAVE1-DELTA.md` |
