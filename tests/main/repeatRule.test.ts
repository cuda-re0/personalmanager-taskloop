import { describe, expect, it } from 'vitest'
import {
  describeRepeatRule,
  matchesRepeatDay,
  parseRepeatRule,
  serializeRepeatRule
} from '../../src/shared/repeatRule'

describe('重复规则', () => {
  it('兼容读入 null / 空串 / DAILY / WEEKLY，写出一律新语法', () => {
    for (const legacy of [null, '', 'DAILY', 'daily']) {
      const r = parseRepeatRule(legacy)
      expect(r.n).toBe(1)
      expect(r.unit).toBe('D')
      expect(serializeRepeatRule(r)).toBe('EVERY:1:D')
    }
    const weekly = parseRepeatRule('WEEKLY:1,3,5')
    expect(weekly.n).toBe(1)
    expect(weekly.unit).toBe('W')
    expect(weekly.weekdays).toEqual([1, 3, 5])
    expect(serializeRepeatRule(weekly)).toBe('EVERY:1:W:1,3,5')
  })

  it('非法值逐个抛错（n、unit、selector、段数）', () => {
    const bad = [
      'EVERY:0:D',
      'EVERY:-1:D',
      'EVERY:1.5:D',
      'EVERY:366:D',
      'EVERY:53:W:1',
      'EVERY:3:X',
      'EVERY:1:W',
      'EVERY:1:W:',
      'EVERY:1:W:8',
      'EVERY:1:M:32',
      'EVERY:1:Y:02-30',
      'EVERY:1:Y:04-31',
      'EVERY:1:Y:13-01',
      'FOO:1:D',
      'EVERY:3',
      'EVERY:3:D:1'
    ]
    for (const rule of bad) {
      expect(() => parseRepeatRule(rule), rule).toThrow('重复规则格式不正确')
    }
  })

  it('每 3 天：从锚点起算，锚点之前不算', () => {
    const rule = 'EVERY:3:D'
    const anchor = '2026-11-06'
    expect(matchesRepeatDay(rule, '2026-11-06', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-11-09', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-11-07', anchor)).toBe(false)
    expect(matchesRepeatDay(rule, '2026-11-05', anchor)).toBe(false)
  })

  it('每周 W：锚点在同一周中部时，锚点之前的同周日期不算（v0.83）', () => {
    const rule = 'EVERY:1:W:1,3,5'
    const anchor = '2026-11-04' // 周三
    expect(matchesRepeatDay(rule, '2026-11-02', anchor)).toBe(false) // 同一周的周一
    expect(matchesRepeatDay(rule, '2026-11-04', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-11-09', anchor)).toBe(true) // 下一周周一
  })

  it('每月 M：锚点在同月中部时，锚点之前的同月日期不算（v0.83）', () => {
    const rule = 'EVERY:1:M:1,15'
    const anchor = '2026-01-15'
    expect(matchesRepeatDay(rule, '2026-01-01', anchor)).toBe(false) // 同一月的 1 号
    expect(matchesRepeatDay(rule, '2026-01-15', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-02-01', anchor)).toBe(true)
  })

  it('每年 Y：锚点同年中部时，锚点之前的当年日期不算（v0.83）', () => {
    const rule = 'EVERY:1:Y:01-01'
    const anchor = '2026-06-15'
    expect(matchesRepeatDay(rule, '2026-01-01', anchor)).toBe(false) // 同一年的 1 月 1 日
    expect(matchesRepeatDay(rule, '2027-01-01', anchor)).toBe(true)
  })

  it('每 2 周的周一三五：按各自所在周的周一算周差', () => {
    const rule = 'EVERY:2:W:1,3,5'
    const anchor = '2026-11-02'
    expect(matchesRepeatDay(rule, '2026-11-02', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-11-04', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-11-09', anchor)).toBe(false)
    expect(matchesRepeatDay(rule, '2026-11-16', anchor)).toBe(true)
  })

  it('每月 31 号：短月补齐到月末', () => {
    const rule = 'EVERY:1:M:31'
    const anchor = '2026-01-31'
    expect(matchesRepeatDay(rule, '2026-02-28', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-04-30', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-05-30', anchor)).toBe(false)
    expect(matchesRepeatDay(rule, '2026-05-31', anchor)).toBe(true)
  })

  it('每 2 月 15 号：按 年*12+月 算月差', () => {
    const rule = 'EVERY:2:M:15'
    const anchor = '2026-11-15'
    expect(matchesRepeatDay(rule, '2026-11-15', anchor)).toBe(true)
    expect(matchesRepeatDay(rule, '2026-12-15', anchor)).toBe(false)
    expect(matchesRepeatDay(rule, '2027-01-15', anchor)).toBe(true)
  })

  it('describeRepeatRule 按文案表逐字输出', () => {
    expect(describeRepeatRule('EVERY:1:D')).toBe('每天')
    expect(describeRepeatRule('EVERY:3:D')).toBe('每 3 天')
    expect(describeRepeatRule('EVERY:1:W:1,3,5')).toBe('每周一、三、五')
    expect(describeRepeatRule('EVERY:2:W:1,3')).toBe('每 2 周的周一、三')
    expect(describeRepeatRule('EVERY:1:M:15')).toBe('每月 15 日')
    expect(describeRepeatRule('EVERY:2:M:1,15')).toBe('每 2 月的 1、15 日')
    expect(describeRepeatRule('EVERY:1:M:')).toBe('每月同日')
    expect(describeRepeatRule('EVERY:1:Y:11-06')).toBe('每年 11 月 6 日')
    expect(describeRepeatRule('EVERY:2:Y:11-06')).toBe('每 2 年的 11 月 6 日')
  })
})
