import { describe, expect, it } from 'vitest'
import type { Task } from '@shared/types/domain'
import { isStale, planReminders } from '../../src/main/services/reminderPlan'

/**
 * 提醒排期纯函数（58 §4）。不碰窗口、不碰 DB：`now` 显式传，时间是死值。
 *
 * 只测「哪些偏移该留、谁轻谁重」——落库、轮询、弹窗都在别处，不在这里证明。
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

/** 固定「现在」：2026-11-01 08:00 本地时间线里的基准点，due 一律给它之后的时刻 */
const NOW = new Date('2026-11-01T00:00:00.000Z')
const DUE_FUTURE = '2026-11-10T00:00:00.000Z'

describe('planReminders（58 §3.1）', () => {
  it('每日任务不生成任何提醒（daily_time 不动，靠 type 判）', () => {
    const task = makeTask({
      id: 't1',
      type: 'daily',
      title: '11 点前睡着',
      dailyTime: '23:00',
      // 即便有人给每日任务塞了偏移和 due，也必须一条都不出
      dueAt: DUE_FUTURE,
      reminderOffsets: [-60]
    })
    expect(planReminders(task, NOW)).toEqual([])
  })

  it('限时两条偏移：前一条 normal、最后一条 strong', () => {
    const task = makeTask({
      id: 't2',
      type: 'deadline',
      title: '交周报',
      dueAt: DUE_FUTURE,
      reminderOffsets: [-1440, -60]
    })
    const plan = planReminders(task, NOW)
    expect(plan).toHaveLength(2)
    expect(plan[0].offsetMin).toBe(-1440)
    expect(plan[0].level).toBe('normal')
    expect(plan[1].offsetMin).toBe(-60)
    expect(plan[1].level).toBe('strong')
  })

  it('活动三条偏移：前两条 strong、最后一条 normal', () => {
    const task = makeTask({
      id: 't3',
      type: 'event',
      title: '答辩',
      dueAt: DUE_FUTURE,
      reminderOffsets: [-10080, -4320, -1440]
    })
    const plan = planReminders(task, NOW)
    expect(plan.map(p => p.offsetMin)).toEqual([-10080, -4320, -1440])
    expect(plan.map(p => p.level)).toEqual(['strong', 'strong', 'normal'])
  })

  it('只有一条偏移时：限时是 strong、活动是 normal', () => {
    const deadline = planReminders(
      makeTask({
        id: 't4',
        type: 'deadline',
        title: '限时一条',
        dueAt: DUE_FUTURE,
        reminderOffsets: [-60]
      }),
      NOW
    )
    expect(deadline).toHaveLength(1)
    expect(deadline[0].level).toBe('strong')

    const event = planReminders(
      makeTask({
        id: 't5',
        type: 'event',
        title: '活动一条',
        dueAt: DUE_FUTURE,
        reminderOffsets: [-60]
      }),
      NOW
    )
    expect(event).toHaveLength(1)
    expect(event[0].level).toBe('normal')
  })

  it('偏移全部落在过去 → 空数组（不补发）', () => {
    const task = makeTask({
      id: 't6',
      type: 'deadline',
      title: '已经过了',
      // due 早于 now，任何负偏移只会更早
      dueAt: '2026-10-30T00:00:00.000Z',
      reminderOffsets: [-1440, -60]
    })
    expect(planReminders(task, NOW)).toEqual([])
  })

  it('任务已结束（done）→ 空数组', () => {
    const task = makeTask({
      id: 't7',
      type: 'deadline',
      title: '做完了',
      status: 'done',
      dueAt: DUE_FUTURE,
      reminderOffsets: [-1440, -60]
    })
    expect(planReminders(task, NOW)).toEqual([])
  })
})

describe('isStale（58b §2.3①）', () => {
  it('到点 5 分钟的那条算新鲜 → false', () => {
    expect(isStale('2026-10-31T23:55:00.000Z', NOW)).toBe(false)
  })

  it('到点 11 分钟的那条算过期 → true', () => {
    expect(isStale('2026-10-31T23:49:00.000Z', NOW)).toBe(true)
  })
})
