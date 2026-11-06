import { fmtDueLabel, fmtRemaining } from '@shared/format'
import { parseRepeatRule, serializeRepeatRule } from '@shared/repeatRule'
import { TYPE_LABEL } from '@shared/taskRules'
import type { NotifyPayload } from '@shared/types/ipc'
import type { MessageMeta, Reminder, Task } from '../../shared/types/domain'
import { broadcast } from '../bus'
import { newId } from '../db/ids'
import { nowIso } from '../db/localDay'
import type { ReminderInsert } from '../db/mappers'
import * as reminderRepo from '../db/repositories/reminderRepo'
import { showNotice } from '../notify/notifyWindow'
import { showMainWindow } from '../windowManager'
import * as alertService from './alertService'
import { dailyClock, isStale, planReminders, REPEAT_REFILL_DAYS } from './reminderPlan'
import * as messageService from './messageService'
import * as taskService from './taskService'

/**
 * 提醒的业务层（v0.58，58 §3.2；v0.78 接回轻弹窗分派与重复任务补建，81 单）。
 *
 * 只做四件事：
 * - `syncForTask` / `syncAll`：把「任务 + 偏移」物化成 `reminders` 行；重复任务改走
 *   `ensureRepeatRows`（增量补建，不整表重建，保住 snooze 过的 active 行）；
 * - `ensureRepeatHorizon`：重复任务的未来 30 天窗口快用完时补建；
 * - `fireDue` / `fireOne`：到点写会话区消息 → 广播 → 标已触发 → 分派窗口。
 *
 * **顺序纪律（§3.2 写死）**：消息写成功之后才 `markFired`。反过来的话，一旦写消息失败，
 * 这条提醒就永远停在"已触发"上——以后再也弹不出来，而用户什么都没收到。
 *
 * 窗口分派（81 单裁决）：`normal` 弹空中轻弹窗，`strong` 唤主窗到最前；过期超过
 * `STALE_POPUP_MS` 的只写消息，既不弹横幅也不唤主窗（与启动补发同口径）。
 */

/** 本单只有站内渠道（mail / webhook 在 W8B 之后） */
const FIRED_CHANNELS = ['inapp'] as const

/** 按任务重建提醒行，返回重建后的全部行（含历史 fired / cancelled） */
export function syncForTask(taskId: string): Reminder[] {
  const task = taskService.getTask(taskId)
  // 任务不存在（刚被删 / id 打错）：没有可排的，静默返回空数组，不抛错——
  // 调用点是三个写 handler 的尾巴，不该因为同步失败把已经成功的写入变成失败
  if (task === null) return []

  const now = new Date()

  if (task.type === 'daily') {
    // 先解析再序列化：把 legacy 'DAILY' / 'WEEKLY:1,3' 归一成 EVERY:，
    // 否则规则没变也会因为字符串不同而把旧行全删一遍
    const repeat = parseRepeatRule(task.repeatRule)
    const rule = serializeRepeatRule(repeat)
    // 日级（每天 / 每 N 天）不提醒；用户从「每周」改成「每天」时历史 active 行必须清掉
    if (repeat.unit === 'D') return reminderRepo.replaceForTask(taskId, [])

    // 没有有效时刻 = 不提醒；旧时刻的行必须清空（用户删掉时刻时不能留着老行照弹）
    const clock = dailyClock(task.dailyTime)
    if (clock === null) return reminderRepo.replaceForTask(taskId, [])
    const clockText = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`

    const repeatRows: Omit<ReminderInsert, 'taskId'>[] = planReminders(task, now).map(plan => ({
      id: newId(),
      occurrenceId: null,
      offsetMin: null,
      fireAt: plan.fireAt,
      repeatRule: rule,
      channels: task.reminderChannels,
      level: 'normal',
      status: 'active',
      createdAt: now.toISOString()
    }))
    return reminderRepo.ensureRepeatRows(taskId, rule, clockText, repeatRows)
  }

  const rows: Omit<ReminderInsert, 'taskId'>[] = planReminders(task, now).map(plan => ({
    id: newId(),
    occurrenceId: null,
    offsetMin: plan.offsetMin,
    fireAt: plan.fireAt,
    repeatRule: null,
    channels: task.reminderChannels,
    level: plan.level,
    status: 'active',
    createdAt: now.toISOString()
  }))
  return reminderRepo.replaceForTask(taskId, rows)
}

/** 对全部进行中的任务跑一遍（启动时补建用；也供将来的"改系统时间"场景调用） */
export function syncAll(): void {
  for (const task of taskService.listTasks({ status: ['todo', 'doing'] })) {
    try {
      syncForTask(task.id)
    } catch (e: unknown) {
      // 单条失败不中断整轮：一条任务的 JSON 字段坏了不该让别的任务都排不上
      console.warn('[reminder] 同步失败', task.id, e)
    }
  }
}

/**
 * 重复任务的滚动补建（81 §4.1）：最远一条 active 绝对时间提醒距现在不足
 * `REPEAT_REFILL_DAYS` 时，重新排一遍未来 30 天；窗口还够就跳过，别每轮白干。
 * 单条失败只 warn，不掀掉整轮。
 */
export function ensureRepeatHorizon(now: Date): void {
  const boundary = now.getTime() + REPEAT_REFILL_DAYS * 86_400_000
  for (const task of taskService.listTasks({ status: ['todo', 'doing'] })) {
    if (task.type !== 'daily') continue
    try {
      const max = reminderRepo.maxActiveAbsoluteFireAt(task.id)
      if (max === null || Date.parse(max) < boundary) syncForTask(task.id)
    } catch (e: unknown) {
      console.warn('[reminder] 重复任务补建失败', task.id, e)
    }
  }
}

/**
 * 清掉已删任务的残留提醒行（v0.85b）。scheduler 不直接 import repo，走这一层薄封装。
 * 不加日志：调用方只知道「清了几行」就够了。
 */
export function purgeInactiveTaskReminders(): number {
  return reminderRepo.purgeForInactiveTasks()
}

/** 取所有已到点（含逾期未触发）的提醒，逐条触发 */
export function fireDue(now: Date): void {
  for (const reminder of reminderRepo.listDue(now.toISOString())) {
    try {
      fireOne(reminder, !isStale(reminder.fireAt, now))
    } catch (e: unknown) {
      console.warn('[reminder] 触发失败', reminder.id, e)
    }
  }
}

/**
 * 触发一条：写会话区消息 → 广播 → 标记已触发 → 按轻重分派窗口（81 §5）。
 *
 * 消息 `role` 是 `system`（00 §5 的链路图：`messages(kind='reminder', role='system')`），
 * 会话区按 `meta.kind` 分派，不看 role。
 *
 * `fresh = false`（过期超过 `STALE_POPUP_MS`）时只留消息，既不弹横幅也不唤主窗。
 */
export function fireOne(reminder: Reminder, fresh = true): void {
  const now = new Date()
  const task = reminder.taskId === null ? null : taskService.getTask(reminder.taskId)

  const meta: MessageMeta = {
    kind: 'reminder',
    reminderId: reminder.id,
    taskId: reminder.taskId,
    title: task === null ? '' : task.title,
    fireAt: reminder.fireAt,
    // 快照：原样抄 reminders.offset_min，不拿 fireAt - dueAt 现算（02 §3.1 的写入义务）
    offsetMin: reminder.offsetMin
  }

  const message = messageService.appendMessage({
    threadId: 'main',
    role: 'system',
    kind: 'reminder',
    meta,
    linkedTaskId: reminder.taskId,
    // 提醒是任务通知，与发送模式无关（v0.73）
    mode: 'task'
  })
  broadcast({ type: 'message.appended', message })

  // 顺序不许反：消息落库成功之后才标已触发
  reminderRepo.markFired(reminder.id, [...FIRED_CHANNELS], nowIso())

  if (!fresh) return
  if (task === null) return

  if (reminder.level === 'strong') {
    try {
      alertService.recordAlert({ level: 'strong', sourceId: reminder.id, title: task.title })
    } catch (e: unknown) {
      // 记不进去也要照常唤窗：用户错过提醒的代价远大于漏一条 N 文记录
      console.warn('[alert] 记录失败', e)
    }
    showMainWindow()
    return
  }
  try {
    alertService.recordAlert({ level: 'normal', sourceId: reminder.id, title: task.title })
  } catch (e: unknown) {
    console.warn('[alert] 记录失败', e)
  }
  showNotice(payloadOf(task, reminder, now))
}

/** 轻弹窗的负载（58c 删掉后由 81 单恢复）：四个显示值一律由主进程算好再推下去 */
function payloadOf(task: Task, reminder: Reminder, now: Date): NotifyPayload {
  return {
    level: reminder.level,
    title: task.title,
    // 重复任务没有 dueAt：两个标签留空，渲染层整块不渲染，不编造「还剩 / 截止」
    remainLabel: task.dueAt === null ? '' : fmtRemaining(task.dueAt, task.type, now),
    typeLabel: TYPE_LABEL[task.type],
    dueLabel: task.dueAt === null ? '' : fmtDueLabel(task.dueAt),
    reminderId: reminder.id
  }
}
