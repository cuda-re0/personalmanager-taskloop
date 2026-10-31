import { describe, expect, it } from 'vitest'
import {
  KIND_LABEL,
  SOURCE_LABEL,
  TONE_LABEL,
  canAddMemory,
  diffPersona,
  type PersonaForm
} from '../../src/renderer/main/features/settings/settingsModel'

/**
 * 设置抽屉的纯逻辑（v0.44）。
 *
 * 这里只测决定行为的三件事：脏值差分的**键集合**（多带一个没改的字段等于把用户没动的值再写一遍）、
 * 新增按钮的可用边界（1~120 字符）、以及三张 label 表与 04 §1 的文案一一对应。
 * 界面纪律在 `settingsWiring.test.ts`，那边是源码断言。
 */

const SAVED: PersonaForm = {
  name: '豆豆',
  userCall: '你',
  personaMd: '回话简短，先给结论',
  tone: 'warm'
}

describe('diffPersona（只提交有变化的字段）', () => {
  it('逐字段全等 → null', () => {
    expect(diffPersona({ ...SAVED }, SAVED)).toBeNull()
  })

  it('只改语气 → 恰好 { tone }，不含其它键', () => {
    const patch = diffPersona({ ...SAVED, tone: 'playful' }, SAVED)
    expect(patch).toEqual({ tone: 'playful' })
    expect(Object.keys(patch ?? {})).toEqual(['tone'])
  })

  it('同时改称呼与人设 → 恰好这两个键', () => {
    const patch = diffPersona({ ...SAVED, userCall: '老许', personaMd: '多说两句' }, SAVED)
    expect(Object.keys(patch ?? {}).sort()).toEqual(['personaMd', 'userCall'])
    expect(patch).toEqual({ userCall: '老许', personaMd: '多说两句' })
  })
})

describe('canAddMemory（trim 后 1~120 字符）', () => {
  it('空串与纯空白 → false', () => {
    expect(canAddMemory('')).toBe(false)
    expect(canAddMemory('   ')).toBe(false)
  })

  it('一个字符 → true', () => {
    expect(canAddMemory('a')).toBe(true)
  })

  it('120 字 → true，121 字 → false（按字符数，不按 String.length）', () => {
    expect(canAddMemory('字'.repeat(120))).toBe(true)
    expect(canAddMemory('字'.repeat(121))).toBe(false)
  })
})

describe('三张 label 表（04 §1 白名单）', () => {
  it('语气：warm/plain/playful → 温柔/直率/活泼', () => {
    expect(Object.keys(TONE_LABEL).sort()).toEqual(['plain', 'playful', 'warm'])
    expect(TONE_LABEL).toEqual({ warm: '温柔', plain: '直率', playful: '活泼' })
  })

  it('记忆类型：profile/preference/fact → 身份/偏好/事实', () => {
    expect(Object.keys(KIND_LABEL).sort()).toEqual(['fact', 'preference', 'profile'])
    expect(KIND_LABEL).toEqual({ profile: '身份', preference: '偏好', fact: '事实' })
  })

  it('来源：auto/manual → 自动/手动', () => {
    expect(Object.keys(SOURCE_LABEL).sort()).toEqual(['auto', 'manual'])
    expect(SOURCE_LABEL).toEqual({ auto: '自动', manual: '手动' })
  })
})
