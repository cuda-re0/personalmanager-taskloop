import { describe, expect, it } from 'vitest'
import type { Message, ReviewVerdict } from '../../src/shared/types/domain'
import {
  countNeedEvidence,
  decideReview
} from '../../src/renderer/main/features/tasks/reviewFlow'

/**
 * 分流表（施工词 33 §3.2 / §7.1、§7.2）。
 *
 * `decideReview` 是审核链路的唯一分流实现：只有 pass 计分，partial 与 fail 的流转
 * **完全一样**（超期判 missed，否则回 doing），need_evidence 停在 reviewing。
 * 这里是纯函数，`now` 显式传入，不读时钟。
 */
const NOW = new Date('2026-10-30T12:00:00.000Z')

function verdictOf(
  verdict: ReviewVerdict['verdict'],
  extra: Partial<ReviewVerdict> = {}
): ReviewVerdict {
  return {
    verdict,
    quality: verdict === 'pass' || verdict === 'partial' ? 'met' : null,
    result: null,
    reason: 'AI 原话',
    followup: null,
    gaps: [],
    ...extra
  }
}

const OVERDUE = { dueAt: '2026-10-29T12:00:00.000Z' }
const NOT_OVERDUE = { dueAt: '2026-10-31T12:00:00.000Z' }

describe('decideReview：4 种 verdict × 是否超期（8 条）', () => {
  it('pass → complete（两种 due 都一样，超期也照常计分）', () => {
    expect(decideReview(verdictOf('pass'), OVERDUE, NOW)).toBe('complete')
    expect(decideReview(verdictOf('pass'), NOT_OVERDUE, NOW)).toBe('complete')
  })

  it('partial → 超期 missed / 未超期 revive', () => {
    expect(decideReview(verdictOf('partial'), OVERDUE, NOW)).toBe('missed')
    expect(decideReview(verdictOf('partial'), NOT_OVERDUE, NOW)).toBe('revive')
  })

  it('fail → 与 partial 完全相同（流转不给 partial 开特例）', () => {
    expect(decideReview(verdictOf('fail'), OVERDUE, NOW)).toBe('missed')
    expect(decideReview(verdictOf('fail'), NOT_OVERDUE, NOW)).toBe('revive')
  })

  it('need_evidence → stay（不流转，停在 reviewing 等补证据）', () => {
    expect(decideReview(verdictOf('need_evidence'), OVERDUE, NOW)).toBe('stay')
    expect(decideReview(verdictOf('need_evidence'), NOT_OVERDUE, NOW)).toBe('stay')
  })
})

describe('decideReview 的边界（§7.2）', () => {
  it('dueAt 恰好等于 now：不算超期', () => {
    expect(decideReview(verdictOf('fail'), { dueAt: NOW.toISOString() }, NOW)).toBe('revive')
  })

  it('dueAt 是非法字符串：按 null 处理，回 doing', () => {
    expect(decideReview(verdictOf('fail'), { dueAt: '不是日期' }, NOW)).toBe('revive')
  })

  it('dueAt 为 null：不判失败，一律回 doing', () => {
    expect(decideReview(verdictOf('fail'), { dueAt: null }, NOW)).toBe('revive')
  })
})

/** 造一条 task_review 消息（只填本条用例关心的字段） */
function reviewMessage(id: string, taskId: string, verdict: ReviewVerdict['verdict']): Message {
  return {
    id,
    threadId: 'thread-demo',
    role: 'assistant',
    kind: 'task_review',
    contentMd: '',
    meta: { kind: 'task_review', taskId, verdict: verdictOf(verdict) },
    linkedTaskId: taskId,
    status: 'sent',
    attachments: [],
    createdAt: '2026-10-30T12:00:00.000Z'
  }
}

describe('countNeedEvidence：连续 need_evidence 的次数（§7.6）', () => {
  it('三条 need 之后又来一条 pass：从尾部数出 0（pass 清零）', () => {
    const messages = [
      reviewMessage('r1', 't1', 'need_evidence'),
      reviewMessage('r2', 't1', 'need_evidence'),
      reviewMessage('r3', 't1', 'need_evidence'),
      reviewMessage('r4', 't1', 'pass')
    ]
    expect(countNeedEvidence(messages, 't1')).toBe(0)
  })

  it('反过来（pass 在最前，之后三条 need）：数出 3', () => {
    const messages = [
      reviewMessage('r1', 't1', 'pass'),
      reviewMessage('r2', 't1', 'need_evidence'),
      reviewMessage('r3', 't1', 'need_evidence'),
      reviewMessage('r4', 't1', 'need_evidence')
    ]
    expect(countNeedEvidence(messages, 't1')).toBe(3)
  })

  it('别的任务的审核消息不参与计数，也不打断连续', () => {
    const messages = [
      reviewMessage('r1', 't1', 'need_evidence'),
      reviewMessage('x1', 't2', 'fail'),
      reviewMessage('r2', 't1', 'need_evidence')
    ]
    expect(countNeedEvidence(messages, 't1')).toBe(2)
    expect(countNeedEvidence(messages, 't2')).toBe(0)
  })
})
