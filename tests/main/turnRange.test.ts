import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/types/domain'
import { turnRangeOf } from '../../src/main/services/aiService'

/** 只关心 role：turnRangeOf 的入参就是 `{ role }[]` */
function roles(...list: Message['role'][]): { role: Message['role'] }[] {
  return list.map(role => ({ role }))
}

describe('turnRangeOf（48 §7.1）：撤回范围到下一条 user 之前', () => {
  it('从下标 0 起只删到第二条 user 之前，end 是开区间', () => {
    expect(turnRangeOf(roles('user', 'assistant', 'system', 'user', 'assistant'), 0)).toEqual({
      start: 0,
      end: 3
    })
  })

  it('最后一条是 user：范围就是它自己', () => {
    expect(turnRangeOf(roles('user', 'assistant', 'user'), 2)).toEqual({ start: 2, end: 3 })
  })

  it('越界返回空范围，不抛', () => {
    expect(turnRangeOf(roles('user', 'assistant', 'user'), 5)).toEqual({ start: 5, end: 5 })
  })
})
