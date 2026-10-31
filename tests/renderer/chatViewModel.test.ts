import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/shared/points/rubric'
import type { PointsConfig } from '../../src/shared/points/rubric'
import type { Message, MessageMeta, ReviewVerdict } from '../../src/shared/types/domain'
import {
  draftPointsOf,
  dueHintToLocal,
  latestReviewOnly,
  localToDueHint
} from '../../src/renderer/main/features/chat/chatViewModel'

/**
 * 只测不改：02 §1 的 dueHint 读侧校验、02 §5.2b 的草稿分值口径。
 */

const CFG: PointsConfig = {
  ...DEFAULT_CONFIG,
  difficultyBase: { ...DEFAULT_CONFIG.difficultyBase, hard: 30 }
}

describe('dueHintToLocal 先验形状（02 §1）', () => {
  it('无年份的 10-30 18:00 返回空串，不交给 new Date', () => {
    // V8 会把它静默解析成 2001-10-30T10:00:00.000Z，不报错
    expect(dueHintToLocal('10-30 18:00')).toBe('')
  })

  it('空值返回空串', () => {
    expect(dueHintToLocal(null)).toBe('')
    expect(dueHintToLocal('')).toBe('')
  })

  it('形状合法但日期不存在的仍是空串', () => {
    expect(dueHintToLocal('2026-13-01T00:00')).toBe('')
  })

  it('完整 ISO 能原样往返，不丢年月日时分', () => {
    const hint = '2026-10-30T10:00:00.000Z'
    expect(localToDueHint(dueHintToLocal(hint))).toBe(hint)
  })

  it('跨年草稿不会被解析到上一年', () => {
    expect(dueHintToLocal('2027-01-05T01:00:00.000Z').startsWith('2027-')).toBe(true)
  })
})

describe('draftPointsOf 收完整 PointsConfig（02 §5.2b）', () => {
  it('限时 hard 取 cfg 的 30，不是 DEFAULT_CONFIG 的 35', () => {
    expect(draftPointsOf({ type: 'deadline', difficulty: 'hard' }, CFG)).toBe(30)
  })

  it('每日取 cfg.dailyBase，不是写死的 1', () => {
    const cfg: PointsConfig = { ...DEFAULT_CONFIG, dailyBase: 2 }
    expect(draftPointsOf({ type: 'daily', difficulty: 'medium' }, cfg)).toBe(2)
  })

  it('活动同样按 difficultyBase 取值', () => {
    expect(draftPointsOf({ type: 'event', difficulty: 'hard' }, CFG)).toBe(30)
  })
})

/**
 * 同一任务只留最新一张审核卡（39 §3）。
 *
 * 补证据后重审会为同一任务再落一条 `task_review` 消息，旧的不消失就会上下两张卡。
 * 过滤只动渲染数组：`useChatData.messages` 还要给翻页拼接和 `isLatest` 用。
 */
const VERDICT: ReviewVerdict = {
  verdict: 'pass',
  quality: 'met',
  result: null,
  reason: '',
  followup: null,
  gaps: []
}

function msgOf(id: string, meta: MessageMeta, role: Message['role'] = 'assistant'): Message {
  return {
    id,
    threadId: 'thread-demo',
    role,
    kind: 'text',
    contentMd: '',
    meta,
    linkedTaskId: null,
    status: 'sent',
    attachments: [],
    createdAt: '2026-10-31T00:00:00.000Z'
  }
}

const reviewOf = (id: string, taskId: string): Message =>
  msgOf(id, { kind: 'task_review', taskId, verdict: VERDICT })

const userSay = (id: string): Message => msgOf(id, { kind: 'none' }, 'user')

describe('latestReviewOnly：同一任务只留最新一张审核卡（39 §3）', () => {
  it('同任务两条审核卡 + 中间一条用户消息 → 只剩后一条，用户消息与另一任务的卡都在', () => {
    const list = [
      reviewOf('r1', 't1'),
      userSay('u1'),
      reviewOf('r2', 't1'),
      reviewOf('r3', 't2')
    ]
    expect(latestReviewOnly(list).map(m => m.id)).toEqual(['u1', 'r2', 'r3'])
  })

  it('不改入参：原数组长度与顺序原样，返回的是新数组', () => {
    const list = [reviewOf('r1', 't1'), reviewOf('r2', 't1')]
    const out = latestReviewOnly(list)
    expect(list.map(m => m.id)).toEqual(['r1', 'r2'])
    expect(out).not.toBe(list)
  })

  it('非审核消息一条不丢（草稿卡、提醒、错误气泡都照旧）', () => {
    const list = [userSay('u1'), msgOf('e1', { kind: 'error', code: 'UNKNOWN', message: 'x', retryable: true })]
    expect(latestReviewOnly(list).map(m => m.id)).toEqual(['u1', 'e1'])
  })

  it('每条任务各自的卡互不影响：三个任务各两张，只剩各自最后一张', () => {
    const list = [
      reviewOf('a1', 't1'),
      reviewOf('b1', 't2'),
      reviewOf('a2', 't1'),
      reviewOf('c1', 't3'),
      reviewOf('b2', 't2')
    ]
    expect(latestReviewOnly(list).map(m => m.id)).toEqual(['a2', 'c1', 'b2'])
  })
})
