import { addDays } from '../db/localDay'
import { dueInstant } from '../../shared/due'
import { toLocalDay } from '../../shared/localDay'
import { matchesRepeatDay, parseRepeatRule } from '../../shared/repeatRule'
import type { ReminderLevel, Task } from '../../shared/types/domain'

/**
 * 「这个任务该有哪些提醒、各自轻重」的**纯函数**（v0.58，58 §3.1；v0.78 加重复任务分支）。
 *
 * 不碰数据库、不碰窗口、不读时钟（`now` 显式传入），所以可以单测。
 * `reminderService.syncForTask()` 把算出来的结果写进 `reminders` 表。
 *
 * 三条纪律：
 * 1. **过去的直接丢，不补发**：`fireAt <= now` 一律不出现在结果里。用户新建一个早已
 *    过了提前量的任务，不该开机就收到一堆"提前一天"的提醒。
 * 2. **排序用 `fireAt` 而不是 `offsetMin`**：日/月级 due（v0.53）下两者不同序，
 *    按 offset 排会把"提前一天"排在"提前一小时"前面，最后一条判错轻重。
 * 3. **轻重只在排序后分配**：限时最后一条重、活动最后一条轻（用户裁决）。
 *
 * 重复任务（81 单，用户 2026-11-06 裁决）走独立分支，不参与上面第 2/3 条：
 * 日级不提醒；周级当天；月级前一天 + 当天；年级前 3 天 + 当天。一律 `normal`、
 * 一律 `offsetMin: null`（绝对时间），与限时/活动的偏移口径互不相干。
 */

export interface PlannedReminder {
  /** null = 绝对时间（重复任务）；否则为相对 dueAt 的分钟偏移 */
  offsetMin: number | null
  /** ISO8601 UTC，与 `reminders.fire_at` 的写法一致（字符串比较即时间比较） */
  fireAt: string
  level: ReminderLevel
}

const MINUTE_MS = 60_000

/** 重复任务一次最多往前排多少天 */
export const REPEAT_HORIZON_DAYS = 30
/** 最远一条提醒距现在不足这么多天时，重新补建未来窗口 */
export const REPEAT_REFILL_DAYS = 7

/** 把 `daily_time` 解析成本地时刻分量；缺失或非法一律 `null`（= 不排提醒，不再有兜底时刻） */
export function dailyClock(value: string | null): { hour: number; minute: number } | null {
  const matched = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim())
  if (matched === null) return null
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** 本地日历日 + 本地时刻 → 本地 Date；绝不经过 UTC 解析 */
function localInstant(day: string, hour: number, minute: number): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute, 0, 0)
}

/**
 * 重复任务的提醒矩阵（81 §2）。只按日历算，不查 occurrence、不查当天完成态。
 * `offsetMin` 一律 null：唯一索引 `uq_reminder_task_offset` 只在 `offset_min IS NOT NULL`
 * 时生效，这样同一个任务才装得下未来 30 天里的多条绝对时间提醒。
 */
function planRepeatReminders(task: Task, now: Date): PlannedReminder[] {
  const ruleText = task.repeatRule
  let rule: ReturnType<typeof parseRepeatRule>
  try {
    rule = parseRepeatRule(ruleText)
  } catch {
    // 库里若有坏规则，宁可这一轮不提醒，也不要让写任务的 handler 跟着失败
    return []
  }
  if (rule.unit === 'D') return []

  // 没有有效时刻 = 不提醒（用户把时刻清空是合法操作，旧行由 syncForTask 清掉）
  const clock = dailyClock(task.dailyTime)
  if (clock === null) return []

  const today = toLocalDay(now)
  const anchor = task.activeFrom ?? toLocalDay(new Date(task.createdAt))
  const horizonEnd = addDays(today, REPEAT_HORIZON_DAYS)
  const last = task.activeTo !== null && task.activeTo < horizonEnd ? task.activeTo : horizonEnd
  const lead = rule.unit === 'W' ? [0] : rule.unit === 'M' ? [-1, 0] : [-3, 0]
  const { hour, minute } = clock

  const result: PlannedReminder[] = []
  const seen = new Set<number>()
  for (let day = today; day <= last; day = addDays(day, 1)) {
    if (!matchesRepeatDay(ruleText, day, anchor)) continue
    for (const offset of lead) {
      const fireDay = addDays(day, offset)
      if (fireDay < today) continue
      if (task.activeTo !== null && fireDay > task.activeTo) continue
      const at = localInstant(fireDay, hour, minute)
      const atMs = at.getTime()
      if (!Number.isFinite(atMs) || atMs <= now.getTime()) continue
      if (seen.has(atMs)) continue
      seen.add(atMs)
      result.push({ offsetMin: null, fireAt: at.toISOString(), level: 'normal' })
    }
  }
  return result.sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0))
}

export function planReminders(task: Task, now: Date): PlannedReminder[] {
  // 1. 只有进行中的任务提醒；done / missed / 待审核一律不出
  if (task.status !== 'todo' && task.status !== 'doing') return []
  // 2. 重复任务走自己的矩阵：日级不提醒，周/月/年按提前量表提醒（81 单裁决）
  if (task.type === 'daily') return planRepeatReminders(task, now)
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
