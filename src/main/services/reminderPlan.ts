import type { ReminderLevel, Task } from '../../shared/types/domain'
import { dueInstant } from '../../shared/due'

/**
 * 「这个任务该有哪些提醒、各自轻重」的**纯函数**（v0.58，58 §3.1）。
 *
 * 不碰数据库、不碰窗口、不读时钟（`now` 显式传入），所以可以单测。
 * `reminderService.syncForTask()` 把它算出来的结果整体写进 `reminders` 表。
 *
 * 三条纪律：
 * 1. **过去的直接丢，不补发**：`fireAt <= now` 一律不出现在结果里。用户新建一个早已
 *    过了提前量的任务，不该开机就收到一堆"提前一天"的提醒。
 * 2. **排序用 `fireAt` 而不是 `offsetMin`**：日/月级 due（v0.53）下两者不同序，
 *    按 offset 排会把"提前一天"排在"提前一小时"前面，最后一条判错轻重。
 * 3. **轻重只在排序后分配**：限时最后一条重、活动最后一条轻（用户裁决）。
 */

export interface PlannedReminder {
  offsetMin: number
  /** ISO8601 UTC，与 `reminders.fire_at` 的写法一致（字符串比较即时间比较） */
  fireAt: string
  level: ReminderLevel
}

const MINUTE_MS = 60_000

export function planReminders(task: Task, now: Date): PlannedReminder[] {
  // 1. 只有进行中的任务提醒；done / missed / 待审核一律不出
  if (task.status !== 'todo' && task.status !== 'doing') return []
  // 2. 每日任务不弹提醒（用户裁决），daily_time 字段保持原样不动
  if (task.type === 'daily') return []
  // 3. 没有截止时刻或没有偏移 = 没什么可排的
  if (task.dueAt === null || task.reminderOffsets.length === 0) return []

  const due = dueInstant(task.dueAt)
  if (due === null) return []

  const nowMs = now.getTime()
  const future = task.reminderOffsets
    .map(offsetMin => ({ offsetMin, at: due.getTime() + offsetMin * MINUTE_MS }))
    .filter(row => row.at > nowMs)
    .map(row => ({ offsetMin: row.offsetMin, fireAt: new Date(row.at).toISOString() }))
    .sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0))

  const lastIndex = future.length - 1
  return future.map((row, index) => {
    const isLast = index === lastIndex
    // 限时：前面全轻、最后一次重；活动反过来（前面全重、最后一次轻）
    const level: ReminderLevel =
      task.type === 'deadline' ? (isLast ? 'strong' : 'normal') : isLast ? 'normal' : 'strong'
    return { offsetMin: row.offsetMin, fireAt: row.fireAt, level }
  })
}

/** 弹窗的"新鲜度"门槛：超过这么久才轮到的那条，只写消息、不弹窗（v0.58b） */
export const STALE_POPUP_MS = 10 * 60_000

/**
 * 这条提醒是不是已经"过期太久"了（v0.58b，58b §2.3①）。
 *
 * 运行期与启动期同一个口径：休眠三小时再唤醒，`setInterval` 只补跑一次 tick，
 * 但那一轮会捞到三条早已到点的行——全都弹窗就是"开机弹一堆历史"的翻版。
 *
 * `fireAt` 解析不出来时返回 `false`（**不判过期**）：数据或时钟异常时宁可弹一次，
 * 也不能因为解析失败把提醒吞掉。
 */
export function isStale(fireAt: string, now: Date): boolean {
  const at = Date.parse(fireAt)
  if (Number.isNaN(at)) return false
  return now.getTime() - at > STALE_POPUP_MS
}
