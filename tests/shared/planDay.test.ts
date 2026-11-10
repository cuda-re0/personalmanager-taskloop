import { describe, expect, it } from 'vitest'
import { isValidPlanDay, visibleOn } from '../../src/shared/planDay'

describe('isValidPlanDay（形状 + 真日历日）', () => {
  it('真实存在的日子', () => {
    expect(isValidPlanDay('2026-11-10')).toBe(true)
    expect(isValidPlanDay('2028-02-29')).toBe(true) // 闰年
  })

  it('形状对但日历上不存在的日子：必须判假，只靠正则不合格', () => {
    expect(isValidPlanDay('2026-02-30')).toBe(false)
    expect(isValidPlanDay('2026-13-01')).toBe(false)
    expect(isValidPlanDay('2027-02-29')).toBe(false) // 平年
  })

  it('形状不对的一律判假', () => {
    expect(isValidPlanDay('2026/11/10')).toBe(false)
    expect(isValidPlanDay('2026-11-1')).toBe(false)
    expect(isValidPlanDay('20261110')).toBe(false)
    expect(isValidPlanDay('')).toBe(false)
  })
})

describe('visibleOn（计划日 <= 今天 才可见）', () => {
  it('没有计划日 → 立刻可见', () => {
    expect(visibleOn(null, '2026-11-10')).toBe(true)
  })

  it('今天 → 可见', () => {
    expect(visibleOn('2026-11-10', '2026-11-10')).toBe(true)
  })

  it('明天 → 不可见', () => {
    expect(visibleOn('2026-11-11', '2026-11-10')).toBe(false)
  })

  it('昨天 → 仍然可见（过期不搬运，只是继续显示）', () => {
    expect(visibleOn('2026-11-09', '2026-11-10')).toBe(true)
  })
})
