import { describe, expect, it } from 'vitest'
import type { Task } from '@shared/types/domain'
import { planReminders } from '../../src/main/services/reminderPlan'

/**
 * 重复任务提醒矩阵（81 §8）。纯函数，`now` 一律钉死本地时刻。
 *
 * 断言纪律：只看本地日期 / 时间分量。`fire_at` 是 ISO8601 UTC 串，
 * 拿 `slice(0,10)` 比日期在东八区会把 09:00 判成前一天，测试会假红或假绿。
 */

function makeTask(seed: Partial<Task> & Pick<Task, 'id' | 'type' | 'title'>): Task {
  return {
    status: 'todo',
    detailMd: '',
    parentId: null,
    sortKey: 0,
    priority: 0,
    difficulty: 'medium',
    estimateMin: null,
    plannedDay: null,
    dueAt: null,
    dailyTime: null,
    repeatRule: null,
    activeFrom: null,
    activeTo: null,
    reminderOffsets: [],
    reminderChannels: ['inapp'],
    tags: [],
    pointsPlanned: 20,
    pointsAwarded: null,
    quality: null,
    requiresEvidence: false,
    evidence: [],
    streakCurrent: 0,
    streakBest: 0,
    source: 'chat',
    aiConfidence: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...seed
  }
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

/** fire_at → 本地日历日 / 本地时刻 / ISO 周几（1=周一 … 7=周日） */
function parts(iso: string): { day: string; hour: number; minute: number; weekday: number } {
  const d = new Date(iso)
  return {
    day: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    hour: d.getHours(),
    minute: d.getMinutes(),
    weekday: d.getDay() === 0 ? 7 : d.getDay()
  }
}

/** 本地 2026-11-01 00:00：所有用例的基准「现在」，早于本单里任何 09:00 提醒 */
const NOW = new Date(2026, 10, 1, 0, 0)

function makeRepeat(seed: Partial<Task> = {}): Task {
  return makeTask({
    id: 'rep',
    type: 'daily',
    title: '重复任务',
    activeFrom: '2026-11-01',
    ...seed
  })
}

describe('planReminders · 重复任务分支（81 §2）', () => {
  it('1. EVERY:1:D → 不提醒', () => {
    expect(planReminders(makeRepeat({ repeatRule: 'EVERY:1:D' }), NOW)).toEqual([])
  })

  it('2. EVERY:3:D → 不提醒', () => {
    expect(planReminders(makeRepeat({ repeatRule: 'EVERY:3:D' }), NOW)).toEqual([])
  })

  it('3. EVERY:1:W:1,3 → 只落周一/周三，一条一天，全为绝对时间 + normal', () => {
    const plan = planReminders(makeRepeat({ repeatRule: 'EVERY:1:W:1,3', dailyTime: '09:00' }), NOW)
    expect(plan.length).toBeGreaterThan(0)

    const rows = plan.map(p => parts(p.fireAt))
    expect(rows.every(r => r.weekday === 1 || r.weekday === 3)).toBe(true)
    expect(new Set(rows.map(r => r.day)).size).toBe(rows.length)
    expect(plan.every(p => p.offsetMin === null && p.level === 'normal')).toBe(true)
  })

  it('4. EVERY:1:M:15 → 14 日与 15 日各一条', () => {
    const plan = planReminders(makeRepeat({ repeatRule: 'EVERY:1:M:15', dailyTime: '09:00' }), NOW)
    expect(plan.map(p => parts(p.fireAt).day)).toEqual(['2026-11-14', '2026-11-15'])
  })

  it('5. EVERY:1:Y:11-06 → 11-03 与 11-06 各一条（now 必须早于 11-03 09:00）', () => {
    // 若把 now 取成 11-06，前 3 天的 11-03 会因「过去的不补发」被丢掉，
    // 这条用例就会假红。基准 now 固定在 11-01 00:00。
    const plan = planReminders(makeRepeat({ repeatRule: 'EVERY:1:Y:11-06', dailyTime: '09:00' }), NOW)
    expect(plan.map(p => parts(p.fireAt).day)).toEqual(['2026-11-03', '2026-11-06'])
  })

  it('6. dailyTime 21:30 → 本地时刻 21:30；null / 空串 / 非法值 → 不排提醒', () => {
    const at2130 = planReminders(
      makeRepeat({ repeatRule: 'EVERY:1:M:15', dailyTime: '21:30' }),
      NOW
    )
    expect(at2130.length).toBeGreaterThan(0)
    expect(at2130.every(p => parts(p.fireAt).hour === 21 && parts(p.fireAt).minute === 30)).toBe(
      true
    )

    for (const value of [null, '', '25:00']) {
      const plan = planReminders(
        makeRepeat({ repeatRule: 'EVERY:1:M:15', dailyTime: value }),
        NOW
      )
      expect(plan).toEqual([])
    }
  })

  it('7. now 已过当天提醒时刻 → 今天那条不出现，下一个命中日出现', () => {
    const now = new Date(2026, 10, 2, 10, 0) // 本地 11-02（周一）10:00
    const weekday = now.getDay() === 0 ? 7 : now.getDay()
    const plan = planReminders(
      makeRepeat({
        repeatRule: `EVERY:1:W:${weekday}`,
        dailyTime: '09:00',
        activeFrom: '2026-11-02'
      }),
      now
    )
    const days = plan.map(p => parts(p.fireAt).day)
    expect(days.length).toBeGreaterThan(0)
    expect(days).not.toContain('2026-11-02')
    expect(days[0]).toBe('2026-11-09')
  })

  it('8. activeTo 早于某提醒日 → 该条不出现', () => {
    const plan = planReminders(
      makeRepeat({ repeatRule: 'EVERY:1:W:1,3', dailyTime: '09:00', activeTo: '2026-11-10' }),
      NOW
    )
    const days = plan.map(p => parts(p.fireAt).day)
    expect(days.length).toBeGreaterThan(0)
    expect(days.every(d => d <= '2026-11-10')).toBe(true)
    expect(days).toContain('2026-11-09')
    expect(days).not.toContain('2026-11-11')
  })

  it('9. 周级 + dailyTime 为 null → 整个分支早退（不是排了但为空）', () => {
    const weekday = NOW.getDay() === 0 ? 7 : NOW.getDay()
    const plan = planReminders(
      makeRepeat({ repeatRule: `EVERY:1:W:${weekday}`, dailyTime: null }),
      NOW
    )
    expect(plan).toEqual([])
  })
})
