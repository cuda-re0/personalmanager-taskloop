import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/shared/points/rubric'
import type { PointsConfig } from '../../src/shared/points/rubric'
import type { TaskDraft } from '../../src/shared/types/domain'
import { normalizeDraft } from '../../src/renderer/main/features/chat/chatViewModel'

/**
 * 只测不改：02 §5.2b 的第三条校验点——草稿归一化必须同时归位难度、重算分值。
 * AI 会给出 daily + hard 这种非法组合，卡面 <select> 匹配不到 option 就是空白。
 */

const CFG: PointsConfig = DEFAULT_CONFIG

function draft(seed: Partial<TaskDraft> & Pick<TaskDraft, 'type' | 'difficulty'>): TaskDraft {
  return {
    localId: 'draft-test',
    title: '测试草稿',
    detailMd: '',
    estimateMin: 30,
    dueHint: null,
    dailyTimeHint: null,
    activeToHint: null,
    reminderOffsets: [],
    tags: [],
    steps: [],
    missingInfo: [],
    requiresEvidence: false,
    confidence: 0.8,
    pointsPlanned: 0,
    ...seed
  }
}

describe('normalizeDraft 归位难度再算分（02 §5.2b）', () => {
  it('daily + hard 归位到 medium', () => {
    const out = normalizeDraft(draft({ type: 'daily', difficulty: 'hard' }), CFG)
    expect(out.difficulty).toBe('medium')
    // daily 的分值恒为 cfg.dailyBase，与难度无关（02 §5.2b / v0.9 裁决），
    // 所以归位不改分值；medium 的 difficultyBase 不参与 daily 的卡面
    expect(out.pointsPlanned).toBe(CFG.dailyBase)
  })

  it('先归位再算分：deadline + epic 归位 hard，分值按 hard 而非 epic', () => {
    const out = normalizeDraft(draft({ type: 'deadline', difficulty: 'epic' }), CFG)
    expect(out.difficulty).toBe('hard')
    expect(out.pointsPlanned).toBe(CFG.difficultyBase.hard)
  })

  it('不修改传入的草稿对象', () => {
    const input = draft({ type: 'daily', difficulty: 'hard' })
    normalizeDraft(input, CFG)
    expect(input.difficulty).toBe('hard')
  })

  it('合法组合原样保留，分值按 cfg 重算', () => {
    const cfg: PointsConfig = {
      ...DEFAULT_CONFIG,
      difficultyBase: { ...DEFAULT_CONFIG.difficultyBase, hard: 30 }
    }
    const out = normalizeDraft(draft({ type: 'deadline', difficulty: 'hard' }), cfg)
    expect(out.difficulty).toBe('hard')
    expect(out.pointsPlanned).toBe(30)
  })

  it('daily 的分值取 cfg.dailyBase', () => {
    const cfg: PointsConfig = { ...DEFAULT_CONFIG, dailyBase: 2 }
    const out = normalizeDraft(draft({ type: 'daily', difficulty: 'trivial' }), cfg)
    expect(out.pointsPlanned).toBe(2)
  })
})
