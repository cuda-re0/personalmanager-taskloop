import { describe, expect, it } from 'vitest'
import type { Task } from '../../src/shared/types/domain'
import { hardGateOf, buildReviewRequest, toVerdict } from '../../src/main/ai/pipelines/review'
import type { ReviewResult } from '../../src/main/ai/schema'

/** review 管线的纯函数部分（开工词 §6 第 6、7 条的 schema 侧 + 归一化） */

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    type: 'deadline',
    status: 'reviewing',
    title: '交物理作业',
    detailMd: '把实验报告整理成 PDF 交上去。',
    parentId: null,
    sortKey: 1,
    priority: 0,
    difficulty: 'medium',
    estimateMin: 60,
    dueAt: '2026-10-30T10:00:00.000Z',
    dailyTime: null,
    repeatRule: null,
    activeFrom: null,
    activeTo: null,
    reminderOffsets: [-1440, -60],
    reminderChannels: ['inapp'],
    tags: [],
    pointsPlanned: 20,
    pointsAwarded: null,
    quality: null,
    requiresEvidence: true,
    evidence: [],
    streakCurrent: 0,
    streakBest: 0,
    source: 'chat',
    aiConfidence: 0.9,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...overrides
  }
}

function reviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: 'pass',
    quality: 'met',
    result: null,
    reason: '截图显示报告已导出为 PDF',
    followup: null,
    ...overrides
  }
}

describe('hardGateOf：硬闸门（03 §4.2 判定标准第 2 条）', () => {
  it('一条证据都没有 → need_evidence，且带追问', () => {
    const verdict = hardGateOf(makeTask(), 0)
    expect(verdict).not.toBeNull()
    expect(verdict?.verdict).toBe('need_evidence')
    expect(verdict?.quality).toBeNull()
    expect(verdict?.result).toBeNull()
    expect(verdict?.followup).not.toBeNull()
    expect(verdict?.gaps).toEqual([])
  })

  it('有证据 → 放行（返回 null，交模型判）', () => {
    expect(hardGateOf(makeTask(), 1)).toBeNull()
  })

  // v0.38 修的 bug：手动建的限时任务 requiresEvidence 恒 false，旧闸门于是直接放给模型，
  // 模型只能凭一句"我做完了"给 pass——什么都不交就能拿满分。
  it('requiresEvidence=false 且证据 0 条 → 仍然 need_evidence（不再看 requiresEvidence）', () => {
    const verdict = hardGateOf(makeTask({ requiresEvidence: false }), 0)
    expect(verdict?.verdict).toBe('need_evidence')
  })
})

describe('toVerdict：归一化（03 §4.2 / §4.7）', () => {
  it('event：quality 恒 met，result 保留', () => {
    const verdict = toVerdict(
      reviewResult({ result: 'exceeded', quality: 'partial', reason: '比赛拿了第三名' }),
      'event'
    )
    expect(verdict.quality).toBe('met')
    expect(verdict.result).toBe('exceeded')
  })

  it("event 的 result 'below' → 强制成 fail（模型返回 pass + below 也接住）", () => {
    const verdict = toVerdict(reviewResult({ verdict: 'pass', result: 'below' }), 'event')
    expect(verdict.verdict).toBe('fail')
    expect(verdict.verdict).not.toBe('pass')
    expect(verdict.result).toBe('below')
  })

  it('非 event：result 恒 null（schema 已拒，这里再收一道）', () => {
    const verdict = toVerdict(reviewResult({ result: 'met' }), 'deadline')
    expect(verdict.result).toBeNull()
  })

  it('fail / need_evidence 不给 quality（没有分可算）', () => {
    expect(toVerdict(reviewResult({ verdict: 'fail' }), 'deadline').quality).toBeNull()
    expect(
      toVerdict(reviewResult({ verdict: 'need_evidence', quality: null }), 'deadline').quality
    ).toBeNull()
  })

  it('gaps 只在 partial 时保留（04 §3.3 只有 partial 卡片逐条列缺口）', () => {
    expect(
      toVerdict(reviewResult({ verdict: 'partial', quality: 'partial', gaps: ['缺数据'] }), 'deadline')
        .gaps
    ).toEqual(['缺数据'])
    expect(
      toVerdict(reviewResult({ verdict: 'pass', gaps: ['不该出现'] }), 'deadline').gaps
    ).toEqual([])
  })
})

describe('buildReviewRequest', () => {
  it('图片证据走 image_url，文字证据与文件证据进文字摘要', () => {
    const messages = buildReviewRequest({
      task: makeTask(),
      evidence: [
        { kind: 'text', text: '我交了' },
        { kind: 'image', mime: 'image/png', bytes: Buffer.from('png') },
        { kind: 'file', mime: 'application/pdf' }
      ]
    })
    const user = messages[1].content as Array<{ type: string; text?: string; image_url?: unknown }>
    expect(user.filter(p => p.type === 'image_url')).toHaveLength(1)
    const text = user.map(p => p.text ?? '').join('\n')
    expect(text).toContain('文字证据：我交了')
    expect(text).toContain('application/pdf')
    expect(text).toContain('证据共 3 条')
  })

  // v0.38：任务摘要里不再写「是否要求证据」——模型看到这一行会以为存在"不需要证据"的例外
  it('system 里说明任务类型，且不出现「是否要求证据」这一行', () => {
    const messages = buildReviewRequest({ task: makeTask(), evidence: [] })
    expect(String(messages[0].content)).toContain('【当前时间】')
    const user = messages[1].content as Array<{ text?: string }>
    const text = user.map(p => p.text ?? '').join('\n')
    expect(text).toContain('任务类型：限时')
    expect(text).not.toContain('是否要求证据')
  })
})
