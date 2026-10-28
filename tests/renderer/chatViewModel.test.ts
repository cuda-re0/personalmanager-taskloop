import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/shared/points/rubric'
import type { PointsConfig } from '../../src/shared/points/rubric'
import {
  draftPointsOf,
  dueHintToLocal,
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
