import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  RUBRIC_VERSION,
  computeAwardedPoints,
  computeDailyPoints,
  computePlannedPoints,
  effortFactor,
  roundPoints
} from '../../src/shared/points/rubric'
import type { Difficulty, Quality } from '../../src/shared/types/domain'

/**
 * 只测不改（08 DELTA · W1-2）：这一组断言逐行对应 02 §5.2 的示例表。
 * rubric.ts 与文档不一致时**报告**，不在这里改实现。
 */

describe('computePlannedPoints（02 §5.2 示例表逐行）', () => {
  const rows: { d: Difficulty; min: number | null; expected: number; formula: string }[] = [
    { d: 'trivial', min: 5, expected: 5.06, formula: '5 × 1.0125' },
    { d: 'trivial', min: 60, expected: 5.75, formula: '5 × 1.15' },
    { d: 'easy', min: 30, expected: 10.75, formula: '10 × 1.075' },
    { d: 'medium', min: 60, expected: 23, formula: '20 × 1.15' },
    { d: 'hard', min: 120, expected: 45.5, formula: '35 × 1.3' },
    { d: 'epic', min: 240, expected: 80, formula: '50 × 1.6' }
  ]

  for (const row of rows) {
    it(`${row.d} ${row.min} min → ${row.expected}（${row.formula}）`, () => {
      expect(computePlannedPoints(row.d, row.min)).toBe(row.expected)
    })
  }

  it('不取整成整数：5.75 / 45.5 / 10.75 都保留 2 位小数', () => {
    expect(Number.isInteger(computePlannedPoints('trivial', 60))).toBe(false)
    expect(Number.isInteger(computePlannedPoints('hard', 120))).toBe(false)
    expect(computePlannedPoints('medium', 60)).toBe(23)
  })

  it('estimateMin 为 null 等于 0 分钟（系数 1.0）', () => {
    expect(computePlannedPoints('medium', null)).toBe(20)
    expect(effortFactor(null)).toBe(1)
  })

  it('时长超过 240 分钟按 240 封顶', () => {
    expect(effortFactor(240)).toBeCloseTo(1.6, 10)
    expect(effortFactor(480)).toBe(effortFactor(240))
    expect(computePlannedPoints('epic', 480)).toBe(80)
  })

  it('上下限：[1, 100]', () => {
    const tiny = { ...DEFAULT_CONFIG, difficultyBase: { ...DEFAULT_CONFIG.difficultyBase, trivial: 0.2 } }
    expect(computePlannedPoints('trivial', 0, tiny)).toBe(1)

    const huge = { ...DEFAULT_CONFIG, difficultyBase: { ...DEFAULT_CONFIG.difficultyBase, epic: 200 } }
    expect(computePlannedPoints('epic', 240, huge)).toBe(100)
  })

  it('配置来自参数而不是硬编码', () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      difficultyBase: { trivial: 3, easy: 6, medium: 12, hard: 22, epic: 32 }
    }
    expect(computePlannedPoints('easy', 30, cfg)).toBe(6.45) // 6 × 1.075
  })
})

describe('computeAwardedPoints（质量系数与逾期扣分）', () => {
  it('partial 0.6 倍：10.75 → 6.45（08 DELTA 的样例值）', () => {
    expect(computeAwardedPoints(10.75, 'partial', 0)).toBe(6.45)
  })

  it('met 1.0 倍：原样返回', () => {
    expect(computeAwardedPoints(10.75, 'met', 0)).toBe(10.75)
  })

  it('exceeded 1.15 倍，且上限是 planned × 1.2', () => {
    expect(computeAwardedPoints(10.75, 'exceeded', 0)).toBe(12.36) // 12.3625 → 12.36
    expect(computeAwardedPoints(10, 'exceeded', 0)).toBe(11.5) // 恰好 1.15 倍，未触顶
  })

  it('逾期每天扣 2 分，最多扣 20 分', () => {
    expect(computeAwardedPoints(20, 'met', 3)).toBe(14) // 20 - 6
    expect(computeAwardedPoints(50, 'met', 20)).toBe(30) // 扣满 20
    expect(computeAwardedPoints(50, 'met', 99)).toBe(30) // 不会扣超过 20
  })

  it('扣到 0 以下会被下限 1 托住（完成即正反馈）', () => {
    expect(computeAwardedPoints(20, 'met', 20)).toBe(1)
    expect(computeAwardedPoints(1, 'partial', 5)).toBe(1)
  })

  it('质量系数与逾期扣分叠加', () => {
    expect(computeAwardedPoints(20, 'exceeded', 1)).toBe(21) // 23 - 2
    expect(computeAwardedPoints(20, 'partial', 2)).toBe(8) // 12 - 4
  })

  it('结果永远落在 [1, planned × 1.2] 内', () => {
    const qualities: Quality[] = ['partial', 'met', 'exceeded']
    for (const q of qualities) {
      for (const overdue of [0, 1, 5, 30]) {
        const v = computeAwardedPoints(33.33, q, overdue)
        expect(v).toBeGreaterThanOrEqual(1)
        expect(v).toBeLessThanOrEqual(roundPoints(33.33 * 1.2))
      }
    }
  })
})

describe('computeDailyPoints / 配置常量', () => {
  it('每日基础分 1，命中 7 / 30 天里程碑才给奖励', () => {
    expect(computeDailyPoints(1)).toEqual({ base: 1, bonus: 0, milestoneReached: null })
    expect(computeDailyPoints(7)).toEqual({ base: 1, bonus: 5, milestoneReached: 7 })
    expect(computeDailyPoints(30)).toEqual({ base: 1, bonus: 20, milestoneReached: 30 })
    expect(computeDailyPoints(31)).toEqual({ base: 1, bonus: 0, milestoneReached: null })
  })

  it('DEFAULT_CONFIG 与 01 §2.7 的默认值一致（B 中档）', () => {
    expect(DEFAULT_CONFIG.difficultyBase).toEqual({
      trivial: 5,
      easy: 10,
      medium: 20,
      hard: 35,
      epic: 50
    })
    expect(DEFAULT_CONFIG.dailyBase).toBe(1)
    expect(DEFAULT_CONFIG.streakBonus).toEqual([
      { days: 7, bonus: 5 },
      { days: 30, bonus: 20 }
    ])
    expect(DEFAULT_CONFIG.dailyCap).toBeNull()
  })

  it('RUBRIC_VERSION 是 v0.6-b', () => {
    expect(RUBRIC_VERSION).toBe('v0.6-b')
  })

  it('roundPoints 收敛到 2 位小数（唯一取整点）', () => {
    expect(roundPoints(5.750000000000001)).toBe(5.75)
    expect(roundPoints(319.99999999999994)).toBe(320)
    expect(roundPoints(12.3625)).toBe(12.36)
  })
})
