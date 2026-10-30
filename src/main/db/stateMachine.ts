import type { TaskStatus, TaskType } from '../../shared/types/domain'
import { appError } from './errors'

/**
 * tasks 状态机（01 §3）。
 *
 * 图：
 *   todo ──开始──→ doing ──提交完成──→ pending_review ──提交审核──→ reviewing ──通过──→ done
 *    │  ↑           │  ↑                    │  ↑                        │                │
 *    │  └──放弃─────┘  └──驳回──────────────┘  └──────取消/超时──────────┘                │
 *    └─────提交完成──────────────────────────→┘                                          │
 *                                                                                       │
 *   done ──24h 内撤销──→ doing（同时写一条负流水冲销）
 *   reviewing ──驳回且已过 due──→ missed（v0.34：判失败，不计分，只能归档）
 *   pending_review ──取消/超时（10 分钟）──→ doing（v0.38：没交材料就退回，不发分不调 AI）
 *   任意状态 ──归档──→ archived
 *
 * 两条硬约束：
 * 1. `daily` 类型**不接受** `pending_review` / `reviewing` / `done` —— 每日任务永远停在
 *    todo/doing，每天的状态在 `task_occurrences.status` 上（01 §3）。
 * 2. `draft` 不是 tasks 的状态，草稿只在 `messages.meta_json` 里。
 */

const EDGES: Record<TaskStatus, TaskStatus[]> = {
  // v0.25：todo 可直达 reviewing。界面没有「开始」按钮，新建任务默认就是 todo，
  // 不允许这条边等于「新建的限时/活动任务永远完不成」。01 §3 的调度器同样需要这条边。
  // v0.38：点完成的落点改成 pending_review（待提交），reviewing 那条边保留给历史数据与调度器。
  todo: ['doing', 'pending_review', 'reviewing', 'discarded', 'archived'],
  doing: ['todo', 'pending_review', 'reviewing', 'discarded', 'archived'],
  // 待提交的四个出口：提交审核 / 取消或超时回 doing / 丢弃 / 归档
  pending_review: ['reviewing', 'doing', 'discarded', 'archived'],
  reviewing: ['doing', 'done', 'missed', 'discarded', 'archived'],
  done: ['doing', 'archived'],
  // v0.34：missed 是终点状态，只有归档一条出口（驳回后超期判失败，不给"复活"）
  missed: ['archived'],
  discarded: ['archived'],
  archived: []
}

const LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  pending_review: '待提交',
  reviewing: '待确认',
  done: '已完成',
  missed: '未完成',
  discarded: '已丢弃',
  archived: '已归档'
}

/** `daily` 不许进的两个「等结果」状态 + 完成态（v0.38 起多 pending_review 一个） */
function isDailyForbidden(to: TaskStatus): boolean {
  return to === 'pending_review' || to === 'reviewing' || to === 'done'
}

export function isTransitionAllowed(type: TaskType, from: TaskStatus, to: TaskStatus): boolean {
  if (type === 'daily' && isDailyForbidden(to)) return false
  // 同态调用视为幂等 no-op：IPC 重放/双击不该变成 409
  if (from === to) return true
  return EDGES[from].includes(to)
}

export function assertTransition(type: TaskType, from: TaskStatus, to: TaskStatus): void {
  if (isTransitionAllowed(type, from, to)) return
  if (type === 'daily' && isDailyForbidden(to)) {
    throw appError('CONFLICT', '每日任务不进入审核/完成状态，请完成当天的打卡', {
      detail: `type=daily, ${from} → ${to}`
    })
  }
  throw appError('CONFLICT', `任务不能从「${LABEL[from]}」直接变为「${LABEL[to]}」`, {
    detail: `${from} → ${to}`
  })
}
