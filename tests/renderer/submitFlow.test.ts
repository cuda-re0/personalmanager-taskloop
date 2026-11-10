import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    plannedDay: null,
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

/**
 * 无证据时的一行小字（39 §4）。
 *
 * 项目没有 DOM 测试栈，照 `tasksPanelWiring` 的惯例做源码断言：这条的本质是
 * "证据数为 0 才渲染、有证据就不进 DOM"，和 CSS 隐藏是两件事，必须能从源码上区分。
 */
const SUBMIT_CARD_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/components/SubmitCard.tsx'),
  'utf8'
)

describe('SubmitCard 的无证据提示（39 §4）', () => {
  /** 承载「还没有证据」的那一行源码 */
  const hintLine = SUBMIT_CARD_SOURCE.split('\n').find(line => line.includes('还没有证据'))

  it('同一行里既是 evidence.length === 0 的条件分支，又只有这四个字', () => {
    expect(hintLine).toBeDefined()
    expect(hintLine).toContain('evidence.length === 0')
    expect(hintLine).toContain('>还没有证据<')
  })

  it('证据数 ≥ 1 时不进 DOM：三元另一支是 null（不是隐藏、不是 opacity）', () => {
    expect(hintLine).toMatch(/: null/)
    expect(hintLine).not.toMatch(/opacity|visibility|display:\s*none/)
  })

  it('全文件只出现一次这四个字：不加标点、没有第二句', () => {
    expect(SUBMIT_CARD_SOURCE.match(/还没有证据/g)).toHaveLength(1)
  })

  it('[提交] 的 disabled 逻辑没被这行小字改写', () => {
    expect(SUBMIT_CARD_SOURCE).toContain('disabled={disabled || evidence.length === 0}')
  })
})

/**
 * 待提交卡的驳回理由行（41 §3）。
 *
 * 旧审核卡被隐藏后，它那行「AI 要你补什么」搬到这张卡上——同一句话换个位置，
 * 所以复用 `.review-reason`，不新增任何样式。`hint` 为 null 时整行不进 DOM。
 */
describe('SubmitCard 的理由行（41 §3）', () => {
  /** 承载理由行的那一行源码 */
  const reasonLine = SUBMIT_CARD_SOURCE.split('\n').find(line => line.includes('className="review-reason"'))

  it('hint 条件渲染在同一行，另一支是 null（没有理由就不进 DOM）', () => {
    expect(reasonLine).toBeDefined()
    expect(reasonLine).toContain('hint ?')
    expect(reasonLine).toMatch(/: null/)
  })

  it('复用 .review-reason，没有为它新造类名', () => {
    expect(SUBMIT_CARD_SOURCE.match(/review-reason/g)).toHaveLength(1)
    expect(SUBMIT_CARD_SOURCE).not.toContain('submit-reason')
  })
})
