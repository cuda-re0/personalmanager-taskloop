import type { MessageMeta, Reminder } from '../../shared/types/domain'
import { broadcast } from '../bus'
import { newId } from '../db/ids'
import { nowIso } from '../db/localDay'
import type { ReminderInsert } from '../db/mappers'
import * as reminderRepo from '../db/repositories/reminderRepo'
import { showMainWindow } from '../windowManager'
import { isStale, planReminders } from './reminderPlan'
import * as messageService from './messageService'
import * as taskService from './taskService'

/**
 * 提醒的业务层（v0.58，58 §3.2）。`reminders` 表早已齐备，缺的只是这层调用方。
 *
 * 只做四件事：
 * - `syncForTask` / `syncAll`：把「任务 + 偏移」物化成 `reminders` 行（整表重建，保留历史）；
 * - `fireDue` / `fireOne`：到点了写会话区消息 + 唤主窗。
 *
 * **顺序纪律（§3.2 写死）**：消息写成功之后才 `markFired`。反过来的话，一旦写消息失败，
 * 这条提醒就永远停在"已触发"上——以后再也弹不出来，而用户什么都没收到。
 *
 * 过期超过 `STALE_POPUP_MS` 的只写消息、不唤主窗（v0.58b），与启动补发的口径一致。
 *
 * v0.63：不再弹独立提醒窗（58 的双形态弹窗退役），改为把主窗提到最前——
 * 用户实测那个 466×93 的小条在主屏顶部根本注意不到，而主窗是他一定在看的地方。
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
 * 触发一条：写会话区消息 → 广播 → 标记已触发 → 唤主窗到最前。
 *
 * 消息 `role` 是 `system`（00 §5 的链路图：`messages(kind='reminder', role='system')`），
 * 会话区按 `meta.kind` 分派，不看 role。
 */
export function fireOne(reminder: Reminder, bringToFront = true): void {
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

  if (task !== null && bringToFront) showMainWindow()
}
