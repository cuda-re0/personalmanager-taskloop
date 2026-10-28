import type { z } from 'zod'
import { app, shell } from 'electron'
import { CH } from '@shared/channels'
import type { AppSettings, Bootstrap } from '@shared/types/ipc'
import type { Occurrence, Task } from '@shared/types/domain'
import { broadcast } from '../bus'
import { appError } from '../db/errors'
import { monthBounds, addDays, isoToLocalDay, todayLocalDay } from '../db/localDay'
import * as occurrenceService from '../db/occurrenceService'
import * as statsRepo from '../db/repositories/statsRepo'
import * as settingRepo from '../db/repositories/settingRepo'
import * as messageService from '../services/messageService'
import * as pointsService from '../services/pointsService'
import * as taskService from '../services/taskService'
import * as hudService from '../services/hudService'
import { runEnvelope } from './envelope'
import { g, parseInput } from './guards'

/**
 * IPC 注册表（05 W2 段交付项 2）。
 *
 * `createHandlers(ipc)` 不直接吃 `ipcMain`，而是接收 `{ handle(ch, fn) }` 接口——
 * 测试传假实现就能把整张表跑起来。`src/main/ipc/index.ts` 的
 * `registerIpcHandlers()` 只是 `createHandlers(ipcMain)`。
 *
 * **只接 WIRED 里的 36 条**（W5 起 promoteDraft、W6 起 task.complete 与 occurrence 三条、
 * W9 起 hud 五条、v0.19 起 task.undo 接通，见 kickoff/09、kickoff/11、kickoff/13、kickoff/14）；
 * NOT_WIRED 一律不注册（不放假 handler、不返假数据），
 * 渲染层调到会收到 Electron 的 "No handler registered"——那是开发期错误，不该被伪装成业务错误。
 */

export interface IpcLike {
  handle(channel: string, fn: (event: unknown, input: unknown) => unknown): void
}

export type HandlerFn = (input: unknown) => unknown

/** 未接通道的归属（05 W2 段的通道归属表；promoteDraft 已随 W5 接通，不在表内） */
export type NotWiredOwner = 'W4' | 'W5' | 'W6' | 'W8' | 'W9' | 'W11'

export const NOT_WIRED: Record<string, { owner: NotWiredOwner }> = {
  // W4：AI 接入
  [CH.msg.send]: { owner: 'W4' },
  [CH.msg.retry]: { owner: 'W4' },
  [CH.ai.confirmDraft]: { owner: 'W4' },
  [CH.ai.rejectDrafts]: { owner: 'W4' },
  [CH.ai.review]: { owner: 'W4' },
  [CH.ai.health]: { owner: 'W4' },
  // W8：提醒（reminders 表在 W8 前恒为空；cancel/snooze 的事件类型也由 W8 一并补）
  [CH.reminder.listByTask]: { owner: 'W8' },
  [CH.reminder.listUpcoming]: { owner: 'W8' },
  [CH.reminder.cancel]: { owner: 'W8' },
  [CH.reminder.snooze]: { owner: 'W8' },
  [CH.reminder.syncForTask]: { owner: 'W8' },
  [CH.reminder.testChannel]: { owner: 'W8' },
  // W9：通知渠道 + 悬浮窗（悬浮窗五条已随 W9 接通，不在表内）
  [CH.channel.list]: { owner: 'W9' },
  [CH.channel.setConfig]: { owner: 'W9' },
  [CH.channel.setGlobal]: { owner: 'W9' },
  // W11：附件存储
  [CH.attachment.add]: { owner: 'W11' }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** `task.updated.changed`：before/after 的真实差异（JSON 串比较，数组/对象字段也能比） */
function diffKeys(before: Task, after: Task): (keyof Task)[] {
  return (Object.keys(before) as (keyof Task)[]).filter(
    key => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  )
}

/** `occurrence.created` 的载荷：调用前后按 id 求差集（ensureRange 真正新建的那些） */
function diffOccurrences(before: Occurrence[], after: Occurrence[]): Occurrence[] {
  const known = new Set(before.map(o => o.id))
  return after.filter(o => !known.has(o.id))
}

/** 当日聚合变化统一走这里（points / tasks_done / occurrences_done 任一变化都要推） */
function broadcastDayStats(day: string): void {
  broadcast({ type: 'daystats.changed', day: statsRepo.getDay(day) })
}

interface Row {
  channel: string
  run: HandlerFn
}

/** 单条注册：入参过 zod → 业务函数 → 包信封。守卫失败抛 INVALID_INPUT，由信封收口 */
function row<G extends z.ZodType>(
  channel: string,
  guard: G,
  fn: (input: z.output<G>) => unknown
): Row {
  return {
    channel,
    run: (input: unknown) => runEnvelope(() => fn(parseInput(guard, input)))
  }
}

/* ------------------------------------------------------------------ *
 * WIRED：本轮接通的 36 条
 * ------------------------------------------------------------------ */

const TABLE: Row[] = [
  /* ---------------- app（4） ---------------- */
  // 返回的就是当前全量快照，**不广播**（02 §3.2b 的例外条款）
  row(CH.app.getBootstrap, g.getBootstrap, (): Bootstrap => {
    const today = todayLocalDay()
    const [year, month] = today.split('-').map(Number)
    const { from, to } = monthBounds(year, month)
    return {
      tasks: taskService.listTasks({ status: ['todo', 'doing', 'reviewing'] }),
      todayOccurrences: occurrenceService.listToday(),
      messages: messageService.recentMessages(30),
      balance: pointsService.balance(),
      today: pointsService.todayStat(),
      monthIndex: statsRepo.dayIndex(from, to),
      recentLedger: pointsService.recentLedger(20),
      settings: settingRepo.getAll(),
      // 通知渠道可用性恒空到 W8（02 §3.1），不许返回假的可用性
      channels: []
    }
  }),
  row(CH.app.setSetting, g.setSetting, input => {
    // 未知 key / undefined 由 settingRepo 自己抛 INVALID_INPUT，这里不重复实现
    settingRepo.set(input.key as keyof AppSettings, input.value as never)
    broadcast({ type: 'app.setting.changed', key: input.key, value: input.value })
  }),
  row(CH.app.openExternal, g.openExternal, input => {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      throw appError('INVALID_INPUT', '只允许打开 http/https 链接', { detail: input.url })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw appError('INVALID_INPUT', '只允许打开 http/https 链接', { detail: input.url })
    }
    // fire-and-forget：handler 语义是 void，不把 shell 的 Promise 透传给信封；
    // 失败只进主进程日志（信封已收口同步路径，异步路径这里自己兜）
    void shell.openExternal(parsed.toString()).catch(e => {
      console.error('[ipc] openExternal 失败', parsed.toString(), e)
    })
  }),
  row(CH.app.quit, g.quit, () => {
    app.quit()
  }),

  /* ---------------- task（11） ---------------- */
  row(CH.task.list, g.list, input => taskService.listTasks(input)),
  row(CH.task.get, g.get, input => {
    // requireById 抛 NOT_FOUND「任务不存在」
    return taskService.getTaskWithSubtasks(input.id)
  }),
  row(CH.task.promoteDraft, g.promoteDraft, input => {
    // occurrence 差集的取样区间与 service 内 ensureRange(今天, +3天) 对齐（开工词交付 3）
    const today = todayLocalDay()
    const rangeTo = addDays(today, 3)
    const before = occurrenceService.listRangeRaw(today, rangeTo)
    const { task, created } = taskService.promoteDraft(input)

    // 幂等早退（同一 draft 第二次确认）：本次零写入，零广播——没有行被创建，
    // 再发 created 类事件语义失真（P2）。连 message.patch 也不发（meta 没变）。
    if (!created) return task

    // v0.21：只广播**今天**那条。`ensureRange(今天, +3天)` 会预生成今天起 4 天的 occurrence
    // （后续日历/提醒按需补齐用），把未来日期一并塞进 `occurrence.created` 会让所有
    // 「今日列表」消费者（右栏①、HUD）出现同名多行；用户逐个点掉就是给未来日期提前打卡。
    // 未来日期界面自己会按需查（listToday / calendar.dayIndex），不需要这条事件。
    const createdOccurrences = diffOccurrences(
      before,
      occurrenceService.listRangeRaw(today, rangeTo)
    ).filter(o => o.day === today)

    // 写操作广播（02 §3.8）：父任务 + 子任务各一条 task.created
    broadcast({ type: 'task.created', task })
    for (const sub of taskService.listTasks({ parentId: task.id })) {
      broadcast({ type: 'task.created', task: sub })
    }
    if (createdOccurrences.length > 0) {
      broadcast({ type: 'occurrence.created', occurrences: createdOccurrences })
    }
    // meta_json 已标 promoted，推给全部窗口把卡片切成已确认态（02 §3.8：message.patch 只许 meta）
    const message = messageService.requireMessage(input.messageId)
    broadcast({ type: 'message.patch', messageId: input.messageId, patch: { meta: message.meta } })
    // createTask 已 bump tasks_created，把最新当日统计推出去（对齐 createManual 的既有模式）
    broadcast({ type: 'daystats.changed', day: statsRepo.getDay(today) })
    return task
  }),
  row(CH.task.update, g.update, input => {
    // 先存 before，调用后求真实差异再广播——不为省这次读而广播空 changed（渲染层整体覆盖）
    const before = taskService.getTask(input.id)
    const after = taskService.updateTask(input.id, input.patch)
    broadcast({
      type: 'task.updated',
      task: after,
      changed: before ? diffKeys(before, after) : []
    })
    return after
  }),
  row(CH.task.transition, g.transition, input => {
    const before = taskService.getTask(input.id)
    const after = taskService.transitionTask(input.id, input.to)
    broadcast({
      type: 'task.updated',
      task: after,
      changed: before ? diffKeys(before, after) : []
    })
    return after
  }),
  /* ---------------- task.complete（1，W6） ---------------- */
  row(CH.task.complete, g.taskComplete, input => {
    const before = taskService.getTask(input.id)
    const { task, entry } = taskService.completeTask(input)
    broadcast({
      type: 'task.updated',
      task,
      changed: before ? diffKeys(before, task) : []
    })
    // entry 为 null = 这次没给分（noPoints），余额没动但今日完成数动了
    broadcast({
      type: 'points.changed',
      balance: pointsService.balance(),
      entry,
      today: pointsService.todayStat()
    })
    broadcastDayStats(todayLocalDay())
    return { task, entry }
  }),
  /* ---------------- task.undo（1，v0.19） ---------------- */
  row(CH.task.undo, g.taskUndo, input => {
    const before = taskService.getTask(input.id)
    const { task, entry } = taskService.undoCompletion(input.id)
    // 不是 done 的任务是同态 no-op（02 §3.2）：本次零写入，零广播——
    // 与 occurrence.skip 对已完成打卡的处理同一条口径，不推内容没变的 task.updated
    if (before === null || before.status !== 'done') return { task, entry }

    broadcast({ type: 'task.updated', task, changed: diffKeys(before, task) })
    // entry 为 null = 这次没有可冲销的行（noPoints 完成的），余额没动
    broadcast({
      type: 'points.changed',
      balance: pointsService.balance(),
      entry,
      today: pointsService.todayStat()
    })
    // 冲销行落在今天（回滚是"现在"发生的事实），tasks_done 减在**原完成日**——两天都要推
    const doneDay = before.completedAt === null ? null : isoToLocalDay(before.completedAt)
    if (doneDay !== null) broadcastDayStats(doneDay)
    if (doneDay !== todayLocalDay()) broadcastDayStats(todayLocalDay())
    return { task, entry }
  }),
  row(CH.task.addEvidence, g.addEvidence, input => {
    const before = taskService.getTask(input.id)
    const after = taskService.addEvidence(input.id, input.evidence)
    broadcast({
      type: 'task.updated',
      task: after,
      changed: before ? diffKeys(before, after) : []
    })
    return after
  }),
  row(CH.task.setRequiresEvidence, g.setRequiresEvidence, input => {
    const before = taskService.getTask(input.id)
    const after = taskService.setRequiresEvidence(input.id, input.value)
    broadcast({
      type: 'task.updated',
      task: after,
      changed: before ? diffKeys(before, after) : []
    })
    return after
  }),
  row(CH.task.reorder, g.reorder, input => {
    // 与 update 同一条 diffKeys 路径：taskRepo.reorder 同时写 sort_key 和 updated_at，
    // 硬编码 ['sortKey'] 会漏掉 updatedAt（审核 P2）
    const before = taskService.getTask(input.id)
    taskService.reorderTask(input.id, input.beforeId)
    const after = taskService.requireTask(input.id)
    broadcast({
      type: 'task.updated',
      task: after,
      changed: before ? diffKeys(before, after) : []
    })
  }),
  row(CH.task.createManual, g.createManual, input => {
    const task = taskService.createTask({ type: input.type, title: input.title, ...input.patch })
    broadcast({ type: 'task.created', task })
    // createTask 里 bumpTasksCreated 了，把最新的当日统计推出去
    broadcast({ type: 'daystats.changed', day: statsRepo.getDay(todayLocalDay()) })
    return task
  }),
  row(CH.task.remove, g.remove, input => {
    // softRemove 对不存在的 id 抛 NOT_FOUND「任务不存在」
    taskService.removeTask(input.id)
    broadcast({ type: 'task.removed', taskId: input.id })
  }),
  row(CH.task.setReminderOffsets, g.setReminderOffsets, input => {
    // 只写 tasks.reminder_offsets，不建 reminders 行（W8 的 syncForTask 落地前 reminders 恒空）
    const before = taskService.getTask(input.id)
    const after = taskService.setReminderOffsets(input.id, input.offsets, input.channels)
    broadcast({
      type: 'task.updated',
      task: after,
      changed: before ? diffKeys(before, after) : []
    })
    return after
  }),

  /* ---------------- occurrence（2，会写库的“读”） ---------------- */
  row(CH.occurrence.today, g.occurrenceToday, () => {
    const today = todayLocalDay()
    const before = occurrenceService.listRangeRaw(today, today)
    const list = occurrenceService.listToday()
    const created = diffOccurrences(before, list)
    if (created.length > 0) broadcast({ type: 'occurrence.created', occurrences: created })
    return list
  }),
  row(CH.occurrence.listByRange, g.listByRange, input => {
    const before = occurrenceService.listRangeRaw(input.from, input.to)
    const list = occurrenceService.listRange(input.from, input.to)
    const created = diffOccurrences(before, list)
    if (created.length > 0) broadcast({ type: 'occurrence.created', occurrences: created })
    return list
  }),

  /* ---------------- occurrence.complete / undo / skip（3，W6） ---------------- */
  row(CH.occurrence.complete, g.occurrenceComplete, input => {
    const { occurrence, entry, streakAfter, taskBefore, task } = pointsService.awardOccurrence(
      input.id
    )
    broadcast({ type: 'occurrence.updated', occurrence })
    broadcast({ type: 'task.updated', task, changed: diffKeys(taskBefore, task) })
    broadcast({
      type: 'points.changed',
      balance: pointsService.balance(),
      entry,
      today: pointsService.todayStat()
    })
    // 流水记在 occurrence.day（可能是补做的往日），聚合按那一天推
    broadcastDayStats(occurrence.day)
    return { occurrence, entry, streakAfter }
  }),
  row(CH.occurrence.undo, g.occurrenceUndo, input => {
    const { occurrence, balanceAfter, taskBefore, task } = pointsService.undoOccurrence(input.id)
    broadcast({ type: 'occurrence.updated', occurrence })
    broadcast({ type: 'task.updated', task, changed: diffKeys(taskBefore, task) })
    // 冲销行落在今天（回滚是"现在"发生的事实），occurrences_done 减在原来那一天
    broadcast({
      type: 'points.changed',
      balance: balanceAfter,
      entry: null,
      today: pointsService.todayStat()
    })
    broadcastDayStats(occurrence.day)
    const today = todayLocalDay()
    if (occurrence.day !== today) broadcastDayStats(today)
    return { occurrence, balanceAfter }
  }),
  row(CH.occurrence.skip, g.occurrenceSkip, input => {
    const occurrence = pointsService.skipOccurrence(input.id, input.note)
    // 已完成的打卡不会退回"跳过"（不加分也不冲销），此时 skipOccurrence 原样返回：
    // 没有写入就不广播，避免发一条内容没变的 occurrence.updated
    if (occurrence.status === 'skipped') {
      broadcast({ type: 'occurrence.updated', occurrence })
    }
    return occurrence
  }),

  /* ---------------- calendar（2） ---------------- */
  row(CH.calendar.dayIndex, g.dayIndex, input => {
    const { from, to } = monthBounds(input.year, input.month)
    return statsRepo.dayIndex(from, to)
  }),
  row(CH.calendar.dayDetail, g.dayDetail, input => statsRepo.dayDetail(input.day)),

  /* ---------------- msg（1） ---------------- */
  row(CH.msg.list, g.msgList, input => messageService.listMessages(input)),

  /* ---------------- points（6） ---------------- */
  row(CH.points.balance, g.balance, () => pointsService.balance()),
  row(CH.points.ledger, g.ledger, input => pointsService.listLedger(input)),
  row(CH.points.monthStats, g.monthStats, input =>
    pointsService.monthStats(input.year, input.month)
  ),
  row(CH.points.adjust, g.adjust, input => {
    const entry = pointsService.adjust(input.delta, input.reason)
    broadcast({
      type: 'points.changed',
      balance: pointsService.balance(),
      entry,
      today: pointsService.todayStat()
    })
    return entry
  }),
  // 纯计算，无副作用
  row(CH.points.preview, g.preview, input =>
    pointsService.previewPoints(input.type, input.difficulty)
  ),
  // 入参里的 current 不参与计算（奖励只由 nextDayWillReach 决定），透传仅为契约形状
  row(CH.points.streakPreview, g.streakPreview, input =>
    pointsService.streakBonusAt(input.nextDayWillReach)
  ),

  /* ---------------- hud（5，W9） ---------------- */
  // 状态与坐标全在 hudService：handler 只做入参校验 + 转发，不在这里算 bounds。
  // setMode 的 `hud.mode.changed` 广播也在 hudService 里（同一处改动同一个广播，避免漏发）。
  row(CH.hud.setMode, g.hudSetMode, input => hudService.setMode(input.mode)),
  row(CH.hud.setExpanded, g.hudSetExpanded, input => hudService.setExpanded(input.expanded)),
  row(CH.hud.moveTo, g.hudMoveTo, input => hudService.moveTo(input.x, input.y)),
  row(CH.hud.setVisible, g.hudSetVisible, input => hudService.setVisible(input.visible)),
  row(CH.hud.getState, g.hudGetState, () => hudService.getState())
]

/** 已接通的通道名（代码里的数据，供覆盖测试用） */
export const WIRED_CHANNELS: readonly string[] = TABLE.map(r => r.channel)

/**
 * 把整张表注册到注入的 ipc 实现上，返回 WIRED 表（channel → handler）。
 * 重复注册同一通道视为程序错误，直接抛（开发期就该炸）。
 */
export function createHandlers(ipc: IpcLike): Map<string, HandlerFn> {
  const wired = new Map<string, HandlerFn>()
  for (const r of TABLE) {
    if (wired.has(r.channel)) {
      throw new Error(`通道重复注册: ${r.channel}`)
    }
    wired.set(r.channel, r.run)
    ipc.handle(r.channel, (_event, input) => r.run(input))
  }
  return wired
}
