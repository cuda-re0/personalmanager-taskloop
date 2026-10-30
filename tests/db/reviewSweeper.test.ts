import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '../../src/shared/types/events'
import { setTransport } from '../../src/main/bus'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
import {
  REVIEW_TIMEOUT_MS,
  sweepPendingReview
} from '../../src/main/services/reviewSweeper'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, openMemoryDb } from './helpers'

/**
 * 待提交超时退回（施工词 36 §6 / §10.4）。
 *
 * 判据只有 `updated_at`：`transition` 写状态时会更新它，所以进 `pending_review` 的那一刻
 * 就是计时起点。测试把 `updated_at` 直接改到过去，再注入 `now`，不依赖真实时钟。
 */

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

const NOW = new Date('2026-10-30T12:00:00.000Z')

beforeEach(() => {
  openMemoryDb()
  setTransport(null)
})

afterEach(() => {
  setTransport(null)
  closeTestDb()
})

/** 建一个停在 `pending_review` 的任务，并把 updated_at 挪到 `minutesAgo` 分钟前 */
function pendingSince(minutesAgo: number, transition: 'pending_review' | 'reviewing' = 'pending_review'): string {
  const task = taskService.createTask({ type: 'deadline', title: '交作业' })
  taskService.transitionTask(task.id, transition)
  const backdated = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()
  taskRepo.updateColumns(task.id, {}, backdated)
  return task.id
}

describe('sweepPendingReview（v0.38 §6）', () => {
  it('停留 11 分钟 → 退回 doing 并广播 task.updated', () => {
    const events: DomainEvent[] = []
    setTransport(e => events.push(e))
    const id = pendingSince(11)

    const revived = sweepPendingReview(NOW)

    expect(revived.map(t => t.id)).toEqual([id])
    expect(taskService.requireTask(id).status).toBe('doing')
    const updated = events.filter(e => e.type === 'task.updated')
    expect(updated).toHaveLength(1)
  })

  it('停留 9 分钟 → 不动（未到 10 分钟）', () => {
    const id = pendingSince(9)
    expect(sweepPendingReview(NOW)).toEqual([])
    expect(taskService.requireTask(id).status).toBe('pending_review')
  })

  it('恰好 10 分钟 → 退回（判据是 <=）', () => {
    const id = pendingSince(REVIEW_TIMEOUT_MS / 60_000)
    expect(sweepPendingReview(NOW).map(t => t.id)).toEqual([id])
    expect(taskService.requireTask(id).status).toBe('doing')
  })

  it('reviewing 状态无论多久都不动（那是 AI 正在看材料）', () => {
    const id = pendingSince(60, 'reviewing')
    expect(sweepPendingReview(NOW)).toEqual([])
    expect(taskService.requireTask(id).status).toBe('reviewing')
  })

  it('本轮没有待提交任务 → 空数组，不报错', () => {
    taskService.createTask({ type: 'deadline', title: '写周报' })
    expect(sweepPendingReview(NOW)).toEqual([])
  })
})
