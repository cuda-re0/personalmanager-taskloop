import type { DayStat, Task } from '../../shared/types/domain'
import { dueInstant, duePrecisionOf } from '../../shared/due'
import { fmtPoints } from '../../shared/format'
import { isoToLocalDay, isoToLocalTime, todayLocalDay } from '../../shared/localDay'

/**
 * 「时间与今日数据段」的拼装（03 §4.3.1 第 3 段）。
 *
 * **纯函数**：入参是任务数组 + `pointsService.todayStat()` 的结果 + 余额，返回三行字符串。
 * 不查库、不读 settings、不看当前时间以外的环境——测试直接喂数据。
 *
 * 三条硬规则（03 §4.3.1，逐字）：
 * - 待办最多列 5 条，超出时末尾加「等 N 条」（N 是总数）；
 * - 标题超过 12 字截断加 `…`；
 * - 每日任务写「每日」，限时/活动写截止时刻（今天 → `今天 HH:mm`，别的日子 → `MM-DD HH:mm`）。
 *
 * 空数据不许出现「0 条待办，0 条已完成」这种机器腔：没有待办就只说没有待办，
 * 一条任务都没有就只说没有任何任务。
 */

/** 待办列表最多列几条（03 §4.3.1） */
export const BRIEF_MAX_ITEMS = 5
/** 标题截断长度（03 §4.3.1） */
export const BRIEF_TITLE_MAX = 12

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export interface ChatBriefInput {
  /** 未完成的任务（`todo` / `doing` / `pending_review` / `reviewing`），顺序即展示顺序 */
  tasks: Task[]
  /** `pointsService.todayStat()` 的原样结果 */
  stat: DayStat
  /** `pointsService.balance()` */
  balance: number
  /** 只给测试钉时间用 */
  now?: Date
  timeZone?: string
}

function truncateTitle(title: string): string {
  const chars = Array.from(title)
  if (chars.length <= BRIEF_TITLE_MAX) return title
  return `${chars.slice(0, BRIEF_TITLE_MAX).join('')}…`
}

function weekdayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

/**
 * 按时分精度写截止（03 §4.3.1，v0.53 扩到三档）：
 * - `month` → `11月`（只知道月份就只写月份）
 * - `day`   → 今天 `今天`，别的日子 `MM-DD`（不带时刻）
 * - `minute`→ 今天 `今天 18:00`，别的日子 `11-02 09:00`
 */
function dueLabel(dueAt: string, today: string, timeZone?: string): string {
  const precision = duePrecisionOf(dueAt)
  if (precision === 'month') return `${Number(dueAt.slice(5, 7))}月`
  if (precision === 'day') {
    const day = dueAt.slice(0, 10)
    return day === today ? '今天' : day.slice(5)
  }
  const day = isoToLocalDay(dueAt, timeZone)
  const time = isoToLocalTime(dueAt, timeZone)
  return day === today ? `今天 ${time}` : `${day.slice(5)} ${time}`
}

function itemLabel(task: Task, today: string, timeZone?: string): string {
  const title = truncateTitle(task.title)
  if (task.type === 'daily') return `${title} · 每日`
  if (task.dueAt === null) return title
  const suffix = task.type === 'deadline' ? ' 截止' : ''
  return `${title} · ${dueLabel(task.dueAt, today, timeZone)}${suffix}`
}

export function buildTodayBrief(input: ChatBriefInput): string {
  const now = input.now ?? new Date()
  const timeZone = input.timeZone
  const today = todayLocalDay(timeZone)
  const pending = input.tasks
  // 已完成 = 限时/活动今天完成数 + 每日打卡数（两个口径不相交，加起来才是 ① 里的「今日已完成」）
  const doneToday = input.stat.tasksDone + input.stat.occurrencesDone
  const overdue = pending.filter(task => {
    // 取不到截止瞬间（非法 / 空）视为未知，不算逾期
    const due = dueInstant(task.dueAt)
    return due !== null && due.getTime() < now.getTime()
  }).length

  const head = `今天是 ${today}（${weekdayOf(today)}）。`

  let body: string
  if (pending.length === 0 && doneToday === 0) {
    body = '今天没有任何任务。'
  } else if (pending.length === 0) {
    body = `今天没有待办任务，已完成 ${doneToday} 条，逾期 ${overdue} 条。`
  } else {
    const shown = pending
      .slice(0, BRIEF_MAX_ITEMS)
      .map(task => itemLabel(task, today, timeZone))
      .join('；')
    const more = pending.length > BRIEF_MAX_ITEMS ? ` 等 ${pending.length} 条` : ''
    body = `今天的任务：待办 ${pending.length} 条（${shown}${more}），已完成 ${doneToday} 条，逾期 ${overdue} 条。`
  }

  const points = `今天已得 ${fmtPoints(input.stat.points)} 分，总积分 ${fmtPoints(input.balance)} 分。`
  return [head, body, points].join('\n')
}
