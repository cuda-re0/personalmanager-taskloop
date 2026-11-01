import { describe, expect, it } from 'vitest'
import {
  dueHasTime,
  dueInstant,
  dueLocalDay,
  duePrecisionOf
} from '../../src/shared/due'

/**
 * due_at 三档精度（v0.53 §3.14）。
 *
 * 断言一律用 `getFullYear/getMonth/getDate/getHours` 这类**本地**方法：`dueInstant` 按系统本地
 * 时区构造，钉 `Asia/Shanghai` 会自相矛盾（跑测试的机器是哪台都一样）。
 */

describe('duePrecisionOf：三档形状由字符串长度直接判定', () => {
  it('minute / day / month 各认一例', () => {
    expect(duePrecisionOf('2026-11-05T09:00')).toBe('minute')
    expect(duePrecisionOf('2026-11-05T09:00:00+08:00')).toBe('minute')
    expect(duePrecisionOf('2026-11-05')).toBe('day')
    expect(duePrecisionOf('2026-11')).toBe('month')
  })

  it('形状不对或日期不存在一律 null', () => {
    const bad = ['2026-13-01', '2026-02-30', '2026-00', '10-30 18:00', '', '2026-11-05T09']
    for (const value of bad) {
      expect(duePrecisionOf(value), `duePrecisionOf(${JSON.stringify(value)})`).toBeNull()
    }
    expect(duePrecisionOf(null)).toBeNull()
    expect(duePrecisionOf(undefined)).toBeNull()
  })
})

describe('dueInstant：日/月级按本地日历归一到截止瞬间（§2.2）', () => {
  it('day → 当天 23:59:59.999，日期不变', () => {
    const at = dueInstant('2026-11-05') as Date
    expect(at.getFullYear()).toBe(2026)
    expect(at.getMonth()).toBe(10)
    expect(at.getDate()).toBe(5)
    expect(at.getHours()).toBe(23)
    expect(at.getMinutes()).toBe(59)
    expect(at.getSeconds()).toBe(59)
    expect(at.getMilliseconds()).toBe(999)
  })

  it('month → 当月最后一天 23:59:59.999（按真实日历，不写死 30/31）', () => {
    const dayOf = (raw: string): string => {
      const d = dueInstant(raw) as Date
      const pad = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    expect(dayOf('2026-11')).toBe('2026-11-30')
    expect(dayOf('2026-02')).toBe('2026-02-28')
    expect(dayOf('2024-02')).toBe('2024-02-29')
    expect(dayOf('2026-04')).toBe('2026-04-30')
    expect(dayOf('2026-01')).toBe('2026-01-31')

    const lastMoment = dueInstant('2026-11') as Date
    expect(lastMoment.getHours()).toBe(23)
    expect(lastMoment.getMinutes()).toBe(59)
    expect(lastMoment.getSeconds()).toBe(59)
    expect(lastMoment.getMilliseconds()).toBe(999)
  })

  it('minute 原样解析；非法 → null', () => {
    const local = new Date('2026-11-05T09:00')
    expect(dueInstant('2026-11-05T09:00')?.getTime()).toBe(local.getTime())
    expect(dueInstant('2026-13-01')).toBeNull()
    expect(dueInstant('2026-11-05T24:70')).toBeNull()
    expect(dueInstant('')).toBeNull()
  })
})

describe('dueLocalDay：截止日的本地日历日（§3.1）', () => {
  it('month → 月末那天；day → 原串前 10 位', () => {
    expect(dueLocalDay('2026-11')).toBe('2026-11-30')
    expect(dueLocalDay('2024-02')).toBe('2024-02-29')
    expect(dueLocalDay('2026-11-05')).toBe('2026-11-05')
  })

  it('minute → 本地日历日（不是 UTC 的切片）', () => {
    const iso = '2026-11-05T09:00:00.000Z'
    const d = new Date(iso)
    const pad = (n: number): string => String(n).padStart(2, '0')
    expect(dueLocalDay(iso)).toBe(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  })

  it('非法 → null', () => {
    expect(dueLocalDay('2026-02-30')).toBeNull()
    expect(dueLocalDay(null)).toBeNull()
  })
})

describe('dueHasTime：只有 minute 为 true', () => {
  it('三档各一次', () => {
    expect(dueHasTime('2026-11-05T09:00')).toBe(true)
    expect(dueHasTime('2026-11-05')).toBe(false)
    expect(dueHasTime('2026-11')).toBe(false)
    expect(dueHasTime(null)).toBe(false)
  })
})
