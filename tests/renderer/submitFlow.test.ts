import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '../../src/shared/types/domain'
import {
  mergePendingSubmit,
  submitForReview
} from '../../src/renderer/main/features/tasks/reviewFlow'

/**
 * 待提交链路的两块纯逻辑（施工词 36 §10.5 / §10.6）。
 *
 * - `submitForReview`：两步是 `transition` → `runReview`，**transition 失败不许调 AI**
 *   （否则任务没进审核就白发一次请求）。
 * - `mergePendingSubmit`：提交中的任务即使已变 `reviewing` 也要留在列表里。
 */

type ApiStub = Record<string, unknown>

function installApi(stub: ApiStub): void {
  ;(globalThis as unknown as { api: ApiStub }).api = stub
}

function taskOf(id: string, updatedAt: string, status: Task['status'] = 'pending_review'): Task {
  return {
    id,
    type: 'deadline',
    title: `任务 ${id}`,
    status,
    detailMd: '',
    parentId: null,
    priority: 0,
    difficulty: 'medium',
    estimateMin: null,
    dueAt: null,
    dailyTime: null,
    repeatRule: null,
    activeFrom: null,
    activeTo: null,
    reminderOffsets: [],
    reminderChannels: [],
    tags: [],
    pointsPlanned: 20,
    pointsAwarded: null,
    quality: null,
    requiresEvidence: true,
    evidence: [],
    source: 'manual',
    aiConfidence: null,
    aiProposal: null,
    sortKey: 0,
    createdAt: updatedAt,
    updatedAt,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    streakCurrent: 0,
    streakBest: 0
  } as Task
}

describe('submitForReview（v0.38 §5）', () => {
  afterEach(() => {
    delete (globalThis as unknown as { api?: unknown }).api
  })

  it('transition 失败 → 返回错误原文，且 ai.review 零调用', async () => {
    const review = vi.fn()
    installApi({
      task: {
        get: vi.fn(async () => ({ ok: true, data: { ...taskOf('t1', '2026-10-30T10:00:00.000Z'), evidence: [{ kind: 'text', text: 'x' }] } })),
        transition: vi.fn(async () => ({ ok: false, error: { message: '任务不能从「待提交」直接变为「待确认」' } }))
      },
      ai: { review }
    })

    expect(await submitForReview('t1')).toBe('任务不能从「待提交」直接变为「待确认」')
    expect(review).not.toHaveBeenCalled()
  })

  it('证据为零 → 返回 null，既不 transition 也不调 AI（按钮侧本该 disabled）', async () => {
    const transition = vi.fn()
    const review = vi.fn()
    installApi({
      task: {
        get: vi.fn(async () => ({ ok: true, data: { ...taskOf('t1', '2026-10-30T10:00:00.000Z'), evidence: [] } })),
        transition
      },
      ai: { review }
    })

    expect(await submitForReview('t1')).toBeNull()
    expect(transition).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
  })
})

describe('mergePendingSubmit：待提交列表（v0.38 §7）', () => {
  it('按 updatedAt 升序（先进的在上）', () => {
    const merged = mergePendingSubmit(
      [
        taskOf('late', '2026-10-30T12:00:00.000Z'),
        taskOf('early', '2026-10-30T09:00:00.000Z')
      ],
      {}
    )
    expect(merged.map(t => t.id)).toEqual(['early', 'late'])
  })

  it('提交中的任务即使已经变成 reviewing，仍留在列表里', () => {
    const merged = mergePendingSubmit([], {
      t1: taskOf('t1', '2026-10-30T10:00:00.000Z', 'reviewing')
    })
    expect(merged).toHaveLength(1)
    expect(merged[0].status).toBe('reviewing')
  })

  it('同一 id 两边都有时以主进程真值为准（不重复、不覆盖成旧快照）', () => {
    const merged = mergePendingSubmit(
      [taskOf('t1', '2026-10-30T10:00:00.000Z')],
      { t1: taskOf('t1', '2026-10-30T09:00:00.000Z', 'reviewing') }
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].status).toBe('pending_review')
  })
})
