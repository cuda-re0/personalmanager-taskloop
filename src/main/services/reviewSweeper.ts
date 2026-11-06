import type { Task } from '../../shared/types/domain'
import { broadcast } from '../bus'
import * as taskRepo from '../db/repositories/taskRepo'
import { listTasks, transitionTask } from './taskService'

/**
 * 待提交任务的超时退回（v0.38，04 §3.2b）。
 *
 * 点完成不再立即送审，任务先进 `pending_review` 等用户交材料。用户走开、关窗、
 * 忘了这回事，任务就会永远停在「待提交」——所以主进程每分钟扫一次，超过
 * `REVIEW_TIMEOUT_MS` 还没提交的自动退回 `doing`（不发分、不调 AI）。
 *
 * 三条边界：
 * 1. **只看 `pending_review`**，`reviewing` 一个都不碰——那边是 AI 正在看材料，
 *    按时间踢回 doing 会把审核中的任务打回原形（这正是 v0.38 要新加状态的原因）。
 * 2. 判据只有 `updated_at`：`transition` 写状态时会更新它，进 `pending_review` 的
 *    那一刻就是计时起点。
 * 3. 不做「窗口可见才扫」这类条件——窗口关着也要照常退回。
 */

/** 停留超过 10 分钟未提交 → 退回 doing */
export const REVIEW_TIMEOUT_MS = 600_000
/** 扫描周期 */
export const SWEEP_INTERVAL_MS = 60_000

/**
 * 扫一轮（导出给测试注入 `now`）。
 *
 * 单条失败只 `console.warn`：一条任务被人手工改过状态、或刚好被提交，不该中断整轮。
 * 返回本轮真正退回的任务，方便测试断言「退了几条」。
 */
export function sweepPendingReview(now: Date = new Date()): Task[] {
  const deadline = now.getTime() - REVIEW_TIMEOUT_MS
  const stale = listTasks({ status: ['pending_review'] }).filter(task => {
    const updated = Date.parse(task.updatedAt)
    if (Number.isNaN(updated)) return false
    return updated <= deadline
  })

  const revived: Task[] = []
  for (const task of stale) {
    try {
      // v0.83：快照与迁转之间状态可能已经变了（用户刚好点了「提交」进 reviewing）。
      // `reviewing → doing` 在状态机里是合法边，不重读校验就会把正在被 AI 审的任务
      // 踢回 doing，随后迟到的审核结果被 `runReview` 判为 skipped 静默丢掉。
      const current = taskRepo.getById(task.id)
      if (
        current === null ||
        current.status !== 'pending_review' ||
        current.updatedAt !== task.updatedAt
      ) {
        continue
      }
      const updated = transitionTask(task.id, 'doing')
      broadcast({ type: 'task.updated', task: updated, changed: ['status', 'updatedAt'] })
      revived.push(updated)
    } catch (e: unknown) {
      console.warn('[review] 待提交超时退回失败', task.id, e)
    }
  }
  return revived
}

/**
 * 启动扫描：立即跑一次（重启后要能补上关机期间超时的那批），之后每分钟一次。
 * 返回 `stop()`，由 `app.before-quit` 调用。
 */
export function startReviewSweeper(): () => void {
  const run = (): void => {
    try {
      sweepPendingReview()
    } catch (e: unknown) {
      // 库还没就绪 / 被关闭：不让它掀掉主进程
      console.warn('[review] sweeper 本轮失败', e)
    }
  }
  run()
  const timer = setInterval(run, SWEEP_INTERVAL_MS)
  return () => clearInterval(timer)
}
