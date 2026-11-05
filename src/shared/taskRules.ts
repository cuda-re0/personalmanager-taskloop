import type { Difficulty, TaskType } from './types/domain'

/**
 * 难度档的排列顺序（从轻到重）。全项目唯一一份，UI 下拉、AI 校验、切换类型时的归位都用它。
 * v0.7 之前这个顺序散在渲染层，导致"下拉顺序"和"就近归位"可能不一致。
 */
export const DIFFICULTY_ORDER: readonly Difficulty[] = [
  'trivial',
  'easy',
  'medium',
  'hard',
  'epic'
]

/**
 * 每类任务可选的难度档（2026-10-28 用户定稿）。
 *
 * 每日任务没有「费劲 / 大工程」，限时任务没有「琐事 / 大工程」，活动没有「琐事 / 简单」。
 * 语义上说得通：每日是"每天都要做的小事"，活动是"一次性的大事"，限时两头都不占。
 *
 * 注意 `medium` 三类都允许，所以新建任务的默认难度用它不会越界。
 */
export const ALLOWED_DIFFICULTIES: Record<TaskType, readonly Difficulty[]> = {
  daily: ['trivial', 'easy', 'medium'],
  deadline: ['easy', 'medium', 'hard'],
  event: ['medium', 'hard', 'epic']
}

export function isDifficultyAllowed(type: TaskType, difficulty: Difficulty): boolean {
  return ALLOWED_DIFFICULTIES[type].includes(difficulty)
}

/**
 * 类型标签。三个词来自 04 §4① 的分组标题，不是新文案。
 *
 * v0.58 起从渲染层 `chatViewModel` 上移到共享层：提醒窗口的负载由**主进程**拼
 * （`NotifyPayload.typeLabel`），主进程不能引渲染进程的模块。渲染层仍从
 * `chatViewModel` 拿到同一个常量（那里是 re-export，不是副本）。
 */
export const TYPE_LABEL: Record<TaskType, string> = {
  daily: '每日',
  deadline: '限时',
  event: '活动'
}

/**
 * 切换任务类型时把难度归位到最近的合法档。
 *
 * 平手取**低**档：切一下类型就白涨几十分，用户会以为系统算错了。
 * 例如 hard 切到 daily：allowed 是 trivial(0)/easy(1)/medium(2)，hard 排 3，
 * 最近的是 medium（距离 1），结果 20 分而不是 35 分。
 */
export function snapDifficulty(type: TaskType, difficulty: Difficulty): Difficulty {
  const allowed = ALLOWED_DIFFICULTIES[type]
  if (allowed.includes(difficulty)) return difficulty

  const target = DIFFICULTY_ORDER.indexOf(difficulty)
  let best = allowed[0]
  let bestDist = Math.abs(DIFFICULTY_ORDER.indexOf(best) - target)
  // allowed 本身按从轻到重排列，配合严格小于比较，平手时保留更轻的那个
  for (const candidate of allowed) {
    const dist = Math.abs(DIFFICULTY_ORDER.indexOf(candidate) - target)
    if (dist < bestDist) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}
