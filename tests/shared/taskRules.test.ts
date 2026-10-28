import { describe, expect, it } from 'vitest'
import {
  ALLOWED_DIFFICULTIES,
  DIFFICULTY_ORDER,
  isDifficultyAllowed,
  snapDifficulty
} from '../../src/shared/taskRules'
import type { Difficulty, TaskType } from '../../src/shared/types/domain'

/**
 * 只测不改：对应 02 §5.2b 的难度档位表与「平手取低档」规则。
 */

const TYPES: TaskType[] = ['daily', 'deadline', 'event']
const DIFFICULTIES: Difficulty[] = ['trivial', 'easy', 'medium', 'hard', 'epic']

describe('ALLOWED_DIFFICULTIES 与 02 §5.2b 一致', () => {
  it('每日：trivial / easy / medium', () => {
    expect([...ALLOWED_DIFFICULTIES.daily]).toEqual(['trivial', 'easy', 'medium'])
  })

  it('限时：easy / medium / hard', () => {
    expect([...ALLOWED_DIFFICULTIES.deadline]).toEqual(['easy', 'medium', 'hard'])
  })

  it('活动：medium / hard / epic', () => {
    expect([...ALLOWED_DIFFICULTIES.event]).toEqual(['medium', 'hard', 'epic'])
  })

  it('三档都包含 medium（所以默认难度不会越界）', () => {
    for (const type of TYPES) expect(ALLOWED_DIFFICULTIES[type]).toContain('medium')
  })

  it('DIFFICULTY_ORDER 从轻到重五档', () => {
    expect([...DIFFICULTY_ORDER]).toEqual(['trivial', 'easy', 'medium', 'hard', 'epic'])
  })
})

describe('isDifficultyAllowed', () => {
  it('合法组合为 true', () => {
    expect(isDifficultyAllowed('daily', 'trivial')).toBe(true)
    expect(isDifficultyAllowed('deadline', 'hard')).toBe(true)
    expect(isDifficultyAllowed('event', 'epic')).toBe(true)
  })

  it('越界组合为 false', () => {
    expect(isDifficultyAllowed('daily', 'hard')).toBe(false)
    expect(isDifficultyAllowed('daily', 'epic')).toBe(false)
    expect(isDifficultyAllowed('deadline', 'trivial')).toBe(false)
    expect(isDifficultyAllowed('deadline', 'epic')).toBe(false)
    expect(isDifficultyAllowed('event', 'trivial')).toBe(false)
    expect(isDifficultyAllowed('event', 'easy')).toBe(false)
  })
})

describe('snapDifficulty：就近归位，平手取低档', () => {
  const cases: { type: TaskType; from: Difficulty; to: Difficulty; why: string }[] = [
    { type: 'daily', from: 'hard', to: 'medium', why: 'hard(3) 最近的是 medium(2)，降成 20 分' },
    { type: 'daily', from: 'epic', to: 'medium', why: 'epic(4) 也只能到 medium(2)' },
    { type: 'deadline', from: 'trivial', to: 'easy', why: 'trivial(0) 升到 easy(1)' },
    { type: 'deadline', from: 'epic', to: 'hard', why: 'epic(4) 降到 hard(3)' },
    { type: 'event', from: 'trivial', to: 'medium', why: 'trivial(0) 升到 medium(2)' },
    { type: 'event', from: 'easy', to: 'medium', why: 'easy(1) 升到 medium(2)' }
  ]

  for (const c of cases) {
    it(`${c.type}: ${c.from} → ${c.to}（${c.why}）`, () => {
      expect(snapDifficulty(c.type, c.from)).toBe(c.to)
    })
  }

  it('event + medium 原样返回', () => {
    expect(snapDifficulty('event', 'medium')).toBe('medium')
  })

  it('已合法的难度一律原样返回（不改动用户的选择）', () => {
    for (const type of TYPES) {
      for (const d of DIFFICULTIES) {
        if (isDifficultyAllowed(type, d)) expect(snapDifficulty(type, d)).toBe(d)
      }
    }
  })

  it('任意组合的结果都落在该类型允许的档位里（15 种组合全覆盖）', () => {
    for (const type of TYPES) {
      for (const d of DIFFICULTIES) {
        expect(ALLOWED_DIFFICULTIES[type]).toContain(snapDifficulty(type, d))
      }
    }
  })

  it('归位只会就近，不会跨过相邻合法档（距离不超过 1 档位）', () => {
    for (const type of TYPES) {
      for (const d of DIFFICULTIES) {
        const from = DIFFICULTY_ORDER.indexOf(d)
        const to = DIFFICULTY_ORDER.indexOf(snapDifficulty(type, d))
        const nearest = Math.min(...ALLOWED_DIFFICULTIES[type].map(x => Math.abs(DIFFICULTY_ORDER.indexOf(x) - from)))
        expect(Math.abs(to - from)).toBe(nearest)
      }
    }
  })
})
