import { describe, expect, it } from 'vitest'
import { CH } from '@shared/channels'
import { expectErrorCode } from '../db/helpers'
import { INVALID_INPUT_MESSAGE, g, guards, parseInput } from '../../src/main/ipc/guards'

describe('guards（zod 形状校验）', () => {
  it('{ id: 123 } → INVALID_INPUT「请求参数格式不正确」', () => {
    try {
      parseInput(g.get, { id: 123 })
      throw new Error('预期抛出 INVALID_INPUT，实际没有抛错')
    } catch (e) {
      expect((e as { code?: string }).code).toBe('INVALID_INPUT')
      expect((e as { message?: string }).message).toBe(INVALID_INPUT_MESSAGE)
    }
  })

  it('month: 13 → 同码 INVALID_INPUT', () => {
    expectErrorCode(() => parseInput(g.dayIndex, { year: 2026, month: 13 }), 'INVALID_INPUT')
  })

  it('month 非整数 → INVALID_INPUT', () => {
    expectErrorCode(() => parseInput(g.monthStats, { year: 2026, month: 1.5 }), 'INVALID_INPUT')
  })

  it('beforeId 允许 string | null，number 不行', () => {
    expect(parseInput(g.reorder, { id: 't1', beforeId: null })).toEqual({
      id: 't1',
      beforeId: null
    })
    expectErrorCode(() => parseInput(g.reorder, { id: 't1', beforeId: 5 }), 'INVALID_INPUT')
  })

  it('patch 允许部分字段；多余的 type 被 zod 剥掉（落库后不可改类型，02 §3.2）', () => {
    const parsed = parseInput(g.update, {
      id: 't1',
      patch: { type: 'daily', title: '新标题' }
    })
    expect(parsed.patch).toEqual({ title: '新标题' })
  })

  it('reminderOffsets 必须 number[]', () => {
    expectErrorCode(
      () => parseInput(g.setReminderOffsets, { id: 't1', offsets: ['-60'] }),
      'INVALID_INPUT'
    )
    expect(parseInput(g.setReminderOffsets, { id: 't1', offsets: [-60] })).toEqual({
      id: 't1',
      offsets: [-60]
    })
  })

  it('无入参通道收到 undefined 通过、收到对象拒绝', () => {
    expect(parseInput(g.getBootstrap, undefined)).toBeUndefined()
    expectErrorCode(() => parseInput(g.getBootstrap, { hack: true }), 'INVALID_INPUT')
  })

  it('未接的通道没有守卫（不放假 handler 的一部分）', () => {
    expect(guards[CH.task.complete]).toBeUndefined()
    expect(guards[CH.attachment.add]).toBeUndefined()
  })
})
