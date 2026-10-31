import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/shared/points/rubric'
import type { PointsConfig } from '../../src/shared/points/rubric'
import type { Message, MessageMeta, ReviewVerdict } from '../../src/shared/types/domain'
import {
  draftPointsOf,
  dueHintToLocal,
  latestNeedEvidenceHint,
  localToDueHint,
  visibleChatMessages
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
 * 一任务一卡位（39 §3 去重 + 41 §2.1 隐藏）。
 *
 * 补证据后重审会为同一任务再落一条 `task_review` 消息；任务回到 `pending_review` 后
 * 又会长出一张待提交卡——两条路都能让同一个任务占两个卡位。
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

const NEED_EVIDENCE = (followup: string | null): ReviewVerdict => ({
  verdict: 'need_evidence',
  quality: null,
  result: null,
  reason: '看不到结果',
  followup,
  gaps: []
})

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

const reviewOf = (id: string, taskId: string, verdict: ReviewVerdict = VERDICT): Message =>
  msgOf(id, { kind: 'task_review', taskId, verdict })

const userSay = (id: string): Message => msgOf(id, { kind: 'none' }, 'user')

/** 没有任务处于待提交：隐藏集为空 */
const NO_HIDDEN: ReadonlySet<string> = new Set<string>()

describe('visibleChatMessages：一任务一卡位（39 §3 + 41 §2.1）', () => {
  it('同任务两条审核卡 + 中间一条用户消息 → 只剩后一条，用户消息与另一任务的卡都在', () => {
    const list = [
      reviewOf('r1', 't1'),
      userSay('u1'),
      reviewOf('r2', 't1'),
      reviewOf('r3', 't2')
    ]
    expect(visibleChatMessages(list, NO_HIDDEN).map(m => m.id)).toEqual(['u1', 'r2', 'r3'])
  })

  it('不改入参：原数组长度与顺序原样，返回的是新数组', () => {
    const list = [reviewOf('r1', 't1'), reviewOf('r2', 't1')]
    const out = visibleChatMessages(list, NO_HIDDEN)
    expect(list.map(m => m.id)).toEqual(['r1', 'r2'])
    expect(out).not.toBe(list)
  })

  it('非审核消息一条不丢（草稿卡、提醒、错误气泡都照旧）', () => {
    const list = [userSay('u1'), msgOf('e1', { kind: 'error', code: 'UNKNOWN', message: 'x', retryable: true })]
    expect(visibleChatMessages(list, NO_HIDDEN).map(m => m.id)).toEqual(['u1', 'e1'])
  })

  it('每条任务各自的卡互不影响：三个任务各两张，只剩各自最后一张', () => {
    const list = [
      reviewOf('a1', 't1'),
      reviewOf('b1', 't2'),
      reviewOf('a2', 't1'),
      reviewOf('c1', 't3'),
      reviewOf('b2', 't2')
    ]
    expect(visibleChatMessages(list, NO_HIDDEN).map(m => m.id)).toEqual(['a2', 'c1', 'b2'])
  })

  it('该任务已有待提交卡 → 它所有审核卡都不渲染（不是只留最新的那张）', () => {
    const list = [
      reviewOf('r1', 't1'),
      userSay('u1'),
      reviewOf('r2', 't1'),
      reviewOf('r3', 't2')
    ]
    // t1 有卡：r1 与 r2 都消失；t2 的 r3 与用户消息照常
    expect(visibleChatMessages(list, new Set(['t1'])).map(m => m.id)).toEqual(['u1', 'r3'])
  })

  it('隐藏集为空不等于全留：空 Set 仍做「同任务取最新」', () => {
    const list = [reviewOf('r1', 't1'), reviewOf('r2', 't1'), reviewOf('r3', 't2')]
    const out = visibleChatMessages(list, new Set<string>())
    expect(out.map(m => m.id)).toEqual(['r2', 'r3'])
    expect(out).not.toEqual(list)
  })
})

describe('latestNeedEvidenceHint：待提交卡的理由行（41 §2.2）', () => {
  it('最新一条是 need_evidence 且有 followup → 有这个 key', () => {
    const list = [reviewOf('r1', 't1', NEED_EVIDENCE('补一张截图')), reviewOf('r2', 't1', NEED_EVIDENCE('再补一张'))]
    expect(latestNeedEvidenceHint(list)).toEqual({ t1: '再补一张' })
  })

  it('followup 为 null / 空串 → 没有这个 key（不是空串）', () => {
    const list = [reviewOf('r1', 't1', NEED_EVIDENCE(null)), reviewOf('r2', 't2', NEED_EVIDENCE('   '))]
    expect(latestNeedEvidenceHint(list)).toEqual({})
  })

  it('最新是 pass、历史上有 need_evidence → 没有这个 key（只认最新那条）', () => {
    const list = [reviewOf('r1', 't1', NEED_EVIDENCE('补一张截图')), reviewOf('r2', 't1', VERDICT)]
    expect(latestNeedEvidenceHint(list)).toEqual({})
  })

  it('多个任务各算各的', () => {
    const list = [
      reviewOf('a1', 't1', NEED_EVIDENCE('A 的理由')),
      reviewOf('b1', 't2', NEED_EVIDENCE('B 的理由')),
      reviewOf('a2', 't1', VERDICT)
    ]
    expect(latestNeedEvidenceHint(list)).toEqual({ t2: 'B 的理由' })
  })
})
