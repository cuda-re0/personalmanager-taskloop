import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  QUALITY_FACTOR,
  RUBRIC_VERSION,
  computeAwardedPoints,
  computeDailyPoints,
  computePlannedPoints,
  efficiencyFactor,
  resultFactor,
  roundPoints
} from '../../src/shared/points/rubric'
import type { Difficulty, EventResult, Quality } from '../../src/shared/types/domain'

/**
 * 只测不改：断言逐行对应 02 §5.2（契约 v0.9 / RUBRIC_VERSION v0.7）。
 * rubric.ts 与文档不一致时**报告**，不在这里改实现。
 *
 * v0.7 的关键变化：时长退出公式。应得分只由难度决定，改的是"能被刷分的口子"而不是"数值好不好看"。
 */

const DIFFICULTIES: Difficulty[] = ['trivial', 'easy', 'medium', 'hard', 'epic']

/** 02 §5.2 的应得分表（B 中档） */
const BASE: Record<Difficulty, number> = { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 }

describe('computePlannedPoints：应得分只看难度（02 §5.2 表）', () => {
  // 这里固定用 event：活动/每日仍走共用表 BASE，本单只降限时
  for (const d of DIFFICULTIES) {
    it(`${d} → ${BASE[d]}`, () => {
      expect(computePlannedPoints('event', d)).toBe(BASE[d])
    })
  }

  /**
   * "与 estimateMin 无关"在 v0.7 已经不是行为差异，而是**签名里没有这个位置**了。
   * 旧实现里时长最多乘到 1.6（epic 240min = 80 分），这里能同时证明两件事：
   * 1) 只有 type + difficulty 两个必填参数（cfg 有默认值，不计入 length）；
   * 2) 每一档的结果都恰好等于基准值，乘不出任何系数。
   */
  it('与 estimateMin 无关：只剩类型与难度两个必填参数，结果恒等于基准值', () => {
    expect(computePlannedPoints.length).toBe(2)
    for (const d of DIFFICULTIES) {
      expect(computePlannedPoints('event', d)).toBe(DEFAULT_CONFIG.difficultyBase[d])
    }
    // 旧公式在 epic + 240min 会给出 80；现在拿不到这个数
    expect(computePlannedPoints('event', 'epic')).not.toBe(80)
  })

  /**
   * 硬检查：estimateMin 不能原路返回。
   *
   * 这里不用 `expect(computePlannedPoints('event', 'epic', 240)).toBe(50)`，因为那个断言和意图正好相反：
   * 第三个位置参数是 `cfg`，不是"多余实参"，传 240 进去会走 `(240).difficultyBase['epic']`
   * → 运行时抛 TypeError（已实测），而不是被 JS 忽略。
   * 反过来说，如果哪天有人把签名改成 `(type, d, estimateMin?, cfg?)` 并"接住但不用"，
   * 这个调用就会从"抛错"变成"安静返回 50"——下面这条 toThrow 立刻红。
   * 也就是说：这条断言在**当前实现**下绿、在**退步之后**红，方向是对的。
   *
   * 上面那行 @ts-expect-error 是编译期那一半：签名一旦多出可选参数，实参 240 就合法了，
   * 指令变成"未使用"，tsc 报 TS2578。它生效的前提是 tests 被某个 tsconfig 覆盖——
   * 自契约 v0.9 起由 tsconfig.test.json 承担（已接进 npm run typecheck），此前是死代码。
   */
  it('estimateMin 不能作为参数回来：编译报错，运行时也当场崩（不静默算错）', () => {
    // @ts-expect-error 第三参数是 cfg，传 240 必须编译报错
    expect(() => computePlannedPoints('event', 'epic', 240)).toThrow(TypeError)
    // 实测：把 estimateMin 加回第三参数后 length 由 2 变 3
    // （TS 的可选参数擦除成无默认值形参，会计入 length），两道一起兜
    expect(computePlannedPoints.length).toBe(2)
  })

  it('上下限：[1, 100]', () => {
    const tiny = {
      ...DEFAULT_CONFIG,
      difficultyBase: { ...DEFAULT_CONFIG.difficultyBase, trivial: 0.2 }
    }
    expect(computePlannedPoints('event', 'trivial', tiny)).toBe(1)

    const huge = {
      ...DEFAULT_CONFIG,
      difficultyBase: { ...DEFAULT_CONFIG.difficultyBase, epic: 200 }
    }
    expect(computePlannedPoints('event', 'epic', huge)).toBe(100)
  })

  it('配置来自参数而不是硬编码（A 轻档），且限时走 deadlineBase', () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      difficultyBase: { trivial: 3, easy: 6, medium: 12, hard: 22, epic: 32 },
      deadlineBase: { easy: 2, medium: 7, hard: 11 },
      dailyBase: 1,
      streakBonus: [...DEFAULT_CONFIG.streakBonus],
      dailyCap: DEFAULT_CONFIG.dailyCap
    }
    expect(computePlannedPoints('event', 'easy', cfg)).toBe(6)
    expect(computePlannedPoints('event', 'epic', cfg)).toBe(32)
    // 限时只认 deadlineBase；同一难度在活动上仍取共用表
    expect(computePlannedPoints('deadline', 'medium', cfg)).toBe(7)
    expect(computePlannedPoints('event', 'medium', cfg)).toBe(12)
  })

  it('deadlineBase 缺档回落到共用表（不产生 NaN）', () => {
    // 限时合法难度只有 easy/medium/hard，epic 必然取不到值
    expect(computePlannedPoints('deadline', 'epic', DEFAULT_CONFIG)).toBe(50)
    expect(computePlannedPoints('deadline', 'trivial', DEFAULT_CONFIG)).toBe(5)
  })
})

describe('efficiencyFactor：限时任务的完成效率（封顶 1.2）', () => {
  const rows: { lead: number | null; expected: number; why: string }[] = [
    { lead: null, expected: 1, why: '不知道提前多久，按 1.0 计' },
    { lead: 0, expected: 1, why: '卡点完成' },
    { lead: 23.9, expected: 1, why: '不足 24h 不给系数' },
    { lead: 24, expected: 1.1, why: '满 24h 进第二档' },
    { lead: 71.9, expected: 1.1, why: '不足 72h 仍是 1.1' },
    { lead: 72, expected: 1.2, why: '满 72h 封顶' },
    { lead: -5, expected: 1, why: '逾期不给惩罚系数（扣分走 overdueDays）' }
  ]

  for (const row of rows) {
    it(`${row.lead} 小时 → ${row.expected}（${row.why}）`, () => {
      expect(efficiencyFactor(row.lead)).toBe(row.expected)
    })
  }
})

describe('resultFactor：活动任务的结果档', () => {
  const rows: { result: EventResult | null; expected: number }[] = [
    { result: 'exceeded', expected: 1.2 },
    { result: 'met', expected: 1.0 },
    { result: 'below', expected: 1.0 },
    { result: null, expected: 1.0 }
  ]

  for (const row of rows) {
    it(`${String(row.result)} → ${row.expected}`, () => {
      expect(resultFactor(row.result)).toBe(row.expected)
    })
  }
})

describe('computeAwardedPoints · 限时（planned = 20）', () => {
  it('提前 96 小时（4 天）达标 → 24（20 × 1.0 × 1.2）', () => {
    expect(
      computeAwardedPoints({ type: 'deadline', planned: 20, quality: 'met', overdueDays: 0, leadHours: 96 })
    ).toBe(24)
  })

  it('提前 30 小时达标 → 22（20 × 1.0 × 1.1）', () => {
    expect(
      computeAwardedPoints({ type: 'deadline', planned: 20, quality: 'met', overdueDays: 0, leadHours: 30 })
    ).toBe(22)
  })

  it('卡点完成 → 20（20 × 1.0 × 1.0）', () => {
    expect(
      computeAwardedPoints({ type: 'deadline', planned: 20, quality: 'met', overdueDays: 0, leadHours: 0 })
    ).toBe(20)
  })

  it('逾期 3 天 → 14（20 − 3 × 2）', () => {
    expect(
      computeAwardedPoints({
        type: 'deadline',
        planned: 20,
        quality: 'met',
        overdueDays: 3,
        leadHours: -72
      })
    ).toBe(14)
  })

  it('提前 4 天且超预期 → 27.6（20 × 1.15 × 1.2）', () => {
    expect(
      computeAwardedPoints({
        type: 'deadline',
        planned: 20,
        quality: 'exceeded',
        overdueDays: 0,
        leadHours: 96
      })
    ).toBe(27.6)
  })

  it('提前 4 天但只做到 partial → 14.4（20 × 0.6 × 1.2）', () => {
    expect(
      computeAwardedPoints({
        type: 'deadline',
        planned: 20,
        quality: 'partial',
        overdueDays: 0,
        leadHours: 96
      })
    ).toBe(14.4)
  })

  it('不传 leadHours 等价于未知 → 按 1.0 计', () => {
    expect(computeAwardedPoints({ type: 'deadline', planned: 20, quality: 'met', overdueDays: 0 })).toBe(
      20
    )
  })
})

describe('computeAwardedPoints · 活动（planned = 20，不看完成度）', () => {
  it('结果达标 → 20', () => {
    expect(
      computeAwardedPoints({ type: 'event', planned: 20, quality: 'met', overdueDays: 0, result: 'met' })
    ).toBe(20)
  })

  it('超预期 → 24（20 × 1.2）', () => {
    expect(
      computeAwardedPoints({
        type: 'event',
        planned: 20,
        quality: 'met',
        overdueDays: 0,
        result: 'exceeded'
      })
    ).toBe(24)
  })

  it('below 不可达 → 兜底按 1.0 计（20 × 1.0）', () => {
    expect(
      computeAwardedPoints({ type: 'event', planned: 20, quality: 'met', overdueDays: 0, result: 'below' })
    ).toBe(20)
  })

  it("quality 传 'partial' 或 'met' 结果相同（活动由 result 表达）", () => {
    const qualities: Quality[] = ['partial', 'met', 'exceeded']
    const values = qualities.map(quality =>
      computeAwardedPoints({ type: 'event', planned: 20, quality, overdueDays: 0, result: 'exceeded' })
    )
    expect(values).toEqual([24, 24, 24])
  })

  it('活动不按逾期扣分（日期事前固定）', () => {
    expect(
      computeAwardedPoints({ type: 'event', planned: 20, quality: 'met', overdueDays: 5, result: 'met' })
    ).toBe(20)
  })

  it('result 缺省按 met 计', () => {
    expect(computeAwardedPoints({ type: 'event', planned: 20, quality: 'met', overdueDays: 0 })).toBe(20)
  })
})

describe('上下限：上限 1.4 倍、下限 1 分', () => {
  it('hard 35 × 1.15 × 1.2 = 48.3 不被截断（上限是 35 × 1.4 = 49）', () => {
    const v = computeAwardedPoints({
      type: 'deadline',
      planned: 35,
      quality: 'exceeded',
      overdueDays: 0,
      leadHours: 96
    })
    expect(v).toBe(48.3)
    expect(v).toBeLessThan(roundPoints(35 * 1.4))
  })

  it('极端扣分不小于 1：5 × 0.6 − 20 → 1', () => {
    expect(
      computeAwardedPoints({
        type: 'deadline',
        planned: 5,
        quality: 'partial',
        overdueDays: 10,
        leadHours: -240
      })
    ).toBe(1)
  })

  it('扣分封顶 20：20 分逾期 20 天 → 1，逾期 99 天也一样', () => {
    const at20 = computeAwardedPoints({
      type: 'deadline',
      planned: 20,
      quality: 'met',
      overdueDays: 20,
      leadHours: -480
    })
    const at99 = computeAwardedPoints({
      type: 'deadline',
      planned: 20,
      quality: 'met',
      overdueDays: 99,
      leadHours: -2376
    })
    expect(at20).toBe(1)
    expect(at99).toBe(at20)
  })

  it('任意组合都落在 [1, planned × 1.4] 内', () => {
    const qualities: Quality[] = ['partial', 'met', 'exceeded']
    for (const planned of [1, 20, 33.33, 50]) {
      for (const quality of qualities) {
        for (const overdueDays of [0, 1, 5, 30]) {
          for (const leadHours of [null, 0, 30, 96, -72]) {
            const v = computeAwardedPoints({
              type: 'deadline',
              planned,
              quality,
              overdueDays,
              leadHours
            })
            expect(v).toBeGreaterThanOrEqual(1)
            expect(v).toBeLessThanOrEqual(roundPoints(planned * 1.4))
          }
        }
      }
    }
  })
})

describe('常量与每日任务（02 §5.1 / §5.3）', () => {
  it("RUBRIC_VERSION === 'v0.9'", () => {
    expect(RUBRIC_VERSION).toBe('v0.9')
  })

  it('QUALITY_FACTOR：0.6 / 1.0 / 1.15', () => {
    expect(QUALITY_FACTOR).toEqual({ partial: 0.6, met: 1.0, exceeded: 1.15 })
  })

  it('DEFAULT_CONFIG 与 02 §5.1 一致（B 中档）', () => {
    expect(DEFAULT_CONFIG.difficultyBase).toEqual(BASE)
    // v0.8：限时独立基数表（2/3/5），共用表一字未动
    expect(DEFAULT_CONFIG.deadlineBase).toEqual({ easy: 2, medium: 3, hard: 5 })
    expect(DEFAULT_CONFIG.dailyBase).toBe(1)
    expect(DEFAULT_CONFIG.streakBonus).toEqual([
      { days: 7, bonus: 5 },
      { days: 30, bonus: 10 }
    ])
    expect(DEFAULT_CONFIG.dailyCap).toBeNull()
  })

  it('每日基础分 1，命中 7 / 30 天里程碑才给奖励', () => {
    expect(computeDailyPoints(1)).toEqual({ base: 1, bonus: 0, milestoneReached: null })
    expect(computeDailyPoints(7)).toEqual({ base: 1, bonus: 5, milestoneReached: 7 })
    expect(computeDailyPoints(30)).toEqual({ base: 1, bonus: 10, milestoneReached: 30 })
    expect(computeDailyPoints(31)).toEqual({ base: 1, bonus: 0, milestoneReached: null })
  })

  it('roundPoints 收敛到 2 位小数（唯一取整点）', () => {
    expect(roundPoints(5.750000000000001)).toBe(5.75)
    expect(roundPoints(319.99999999999994)).toBe(320)
    expect(roundPoints(12.3625)).toBe(12.36)
    expect(roundPoints(27.600000000000005)).toBe(27.6)
  })
})
