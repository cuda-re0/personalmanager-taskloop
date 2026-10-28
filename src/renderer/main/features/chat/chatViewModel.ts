import { computePlannedPoints } from '@shared/points/rubric'
import type { Difficulty, TaskDraft, TaskType } from '@shared/types/domain'

/** 类型标签。三个词来自 04 §4① 的分组标题，不是新文案。 */
export const TYPE_LABEL: Record<TaskType, string> = {
  daily: '每日',
  deadline: '限时',
  event: '活动'
}

export const TYPE_ORDER: TaskType[] = ['daily', 'deadline', 'event']

/** 难度显示名。04 §3.2（2026-10-28 用户定稿）：不显示英文原值。 */
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  trivial: '琐事',
  easy: '简单',
  medium: '中等',
  hard: '费劲',
  epic: '大工程'
}

/** 04 §3.2：切换类型时 reminderOffsets 换成该类型默认值 */
export const TYPE_DEFAULT_OFFSETS: Record<TaskType, number[]> = {
  daily: [],
  deadline: [-1440, -60],
  event: [-10080, -4320, -1440]
}

/**
 * pointsPlanned 的唯一口径：daily 取调用方给的当日基数，deadline / event 看难度。
 *
 * 显示、切类型重算、W5 写库都必须是这一个数——显示 1 却存 20，每日任务
 * 就会变成每天 20 分。基数不在这里写死：模块级常量 W2 接上 settings 后替换不掉。
 */
export function draftPointsOf(
  draft: Pick<TaskDraft, 'type' | 'difficulty'>,
  dailyBase: number
): number {
  return draft.type === 'daily' ? dailyBase : computePlannedPoints(draft.difficulty)
}

/** 偏移分钟 → 只读小字。04 §3.2 的例子是「前 1 天 · 前 1 小时」 */
export function offsetLabel(min: number): string {
  const abs = Math.abs(min)
  if (abs % 1440 === 0) return `前 ${abs / 1440} 天`
  if (abs % 60 === 0) return `前 ${abs / 60} 小时`
  return `前 ${abs} 分钟`
}

/**
 * 距截止的显示串（04 §3.3）：`提前 4 天` / `提前 30 小时` / `逾期 3 天`。
 * 只有整数天（≥24h 且能被 24 整除）才说「天」，避免把 30 小时说成 1 天。
 * 不足 1 小时返回空串，卡片整条不显示。
 *
 * 逾期天数必须由调用方传入扣分用的那个数（overdueDaysOf），不许在这里各算各的：
 * 逾期 80 小时若显示「80 小时」、扣分却按 3 天，两处就对不上。
 */
export function leadLabel(leadHours: number, overdueDays = 0): string {
  if (leadHours < 0) {
    if (overdueDays >= 1) return `逾期 ${overdueDays} 天`
    const late = Math.floor(-leadHours)
    return late >= 1 ? `逾期 ${late} 小时` : ''
  }
  const hours = Math.floor(leadHours)
  if (hours < 1) return ''
  if (hours >= 24 && hours % 24 === 0) return `提前 ${hours / 24} 天`
  return `提前 ${hours} 小时`
}

/**
 * 触发点只读串。daily 没有 offsets，走「每日 21:00」这种形式（04 里
 * ReminderPayload.offsetLabel 的示例就是 '每日 21:00'）。
 */
export function reminderSummary(type: TaskType, dailyTime: string | null, offsets: number[]): string {
  if (type === 'daily') return dailyTime ? `每日 ${dailyTime}` : ''
  return offsets.map(offsetLabel).join(' · ')
}

/** mime → 附件角标文字（Attachment 没有文件名字段，只能显示类型） */
export function mimeExt(mime: string | null): string {
  if (!mime) return ''
  const sub = mime.split('/')[1]
  if (!sub) return ''
  return sub.split('+')[0].toLowerCase()
}

/**
 * TaskDraft.dueHint（完整 ISO8601 UTC，02 §1）→ datetime-local 值。
 *
 * 必须走 Date 再取本地字段：直接 slice(0,16) 切出来的是 UTC 字符串，
 * 和用户眼里的本地时间差 8 小时。空值/非法值一律返回 ''，不 fallback 到今天。
 */
export function dueHintToLocal(hint: string | null): string {
  if (!hint) return ''
  const d = new Date(hint)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * datetime-local 值 → TaskDraft.dueHint（完整 ISO8601 UTC）。
 *
 * `new Date('2026-10-30T18:00')` 不带时区后缀，按本地时区解析，这是对的；
 * 只有日期的 `'2026-10-30'` 会被当成 UTC，所以非法值先挡掉再 toISOString。
 */
export function localToDueHint(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString()
}
