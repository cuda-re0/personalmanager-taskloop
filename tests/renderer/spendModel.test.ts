import { describe, expect, it } from 'vitest'
import { fmtMoney } from '@shared/format'
import {
  isOverBudget,
  parseAmountToCents,
  spendHeaderText
} from '../../src/renderer/main/features/points/spendModel'

/**
 * 支出页的纯模型（45 §10 第三组）。
 *
 * 这一组的重点是**金额解析不许碰浮点**：'12.5' 必须得到 1250 而不是
 * `parseFloat('12.5') * 100 = 1250.0000000000002`。
 */

describe('parseAmountToCents', () => {
  it('整数、一位小数、两位小数都按字符串拼成"分"', () => {
    expect(parseAmountToCents('12')).toBe(1200)
    expect(parseAmountToCents('12.5')).toBe(1250)
    expect(parseAmountToCents('12.05')).toBe(1205)
  })

  it('三位小数、0、负数、超上限、非数字都拒绝', () => {
    expect(parseAmountToCents('12.555')).toBeNull()
    expect(parseAmountToCents('0')).toBeNull()
    expect(parseAmountToCents('-3')).toBeNull()
    expect(parseAmountToCents('1000.01')).toBeNull()
    expect(parseAmountToCents('abc')).toBeNull()
  })

  it('前后空格先 trim，允许单位以外的空白', () => {
    expect(parseAmountToCents(' 8 ')).toBe(800)
  })
})

describe('spendHeaderText', () => {
  it('汇率 1、已花 128 元', () => {
    expect(spendHeaderText(10, 1, 12800)).toBe('10 月 · 1 分 = 1 元 · 已花 128 / 500')
  })

  it('汇率 1.08、已花 128.5 元', () => {
    expect(spendHeaderText(10, 1.08, 12850)).toBe('10 月 · 1 分 = 1.08 元 · 已花 128.5 / 500')
  })
})

describe('isOverBudget', () => {
  it('正好花完不算超，多 1 分才算', () => {
    expect(isOverBudget(50000)).toBe(false)
    expect(isOverBudget(50001)).toBe(true)
  })
})

describe('fmtMoney', () => {
  it('整数不带小数，有小数保留两位并去尾零', () => {
    expect(fmtMoney(1200)).toBe('12')
    expect(fmtMoney(1250)).toBe('12.5')
    expect(fmtMoney(1205)).toBe('12.05')
  })
})
