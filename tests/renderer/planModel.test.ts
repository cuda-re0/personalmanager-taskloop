import { describe, expect, it } from 'vitest'
import type { Task, TaskType } from '@shared/types/domain'
import { groupByPlanDay } from '../../src/renderer/main/features/plan/planModel'

/** 计划面板的分组模型（92a §2.1）。造数器只填分组/排序用到的字段 */
function makeTask(seed: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    type: 'deadline' as TaskType,
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

describe('groupByPlanDay（92a：按计划日铺开）', () => {
  it('同一天的两条进同一组，另一天单独一组', () => {
    const tasks = [
      makeTask({ id: 'a', title: 'A', plannedDay: '2026-11-15' }),
      makeTask({ id: 'b', title: 'B', plannedDay: '2026-11-15' }),
      makeTask({ id: 'c', title: 'C', plannedDay: '2026-11-16' })
    ]

    const groups = groupByPlanDay(tasks)
    expect(groups).toHaveLength(2)
    expect(groups[0].day).toBe('2026-11-15')
    expect(groups[0].tasks.map(t => t.id)).toEqual(['a', 'b'])
    expect(groups[1].day).toBe('2026-11-16')
    expect(groups[1].tasks.map(t => t.id)).toEqual(['c'])
  })

  it('plannedDay 为 null 的任务不出现', () => {
    const tasks = [
      makeTask({ id: 'a', title: 'A', plannedDay: '2026-11-15' }),
      makeTask({ id: 'none', title: '没有计划日' })
    ]
    expect(groupByPlanDay(tasks).flatMap(g => g.tasks).map(t => t.id)).toEqual(['a'])
  })

  it('子任务不出现（计划视图只落顶层任务）', () => {
    const tasks = [
      makeTask({ id: 'parent', title: '父任务', plannedDay: '2026-11-15' }),
      makeTask({ id: 'step', title: '子步骤', plannedDay: '2026-11-15', parentId: 'p1' })
    ]
    expect(groupByPlanDay(tasks).flatMap(g => g.tasks).map(t => t.id)).toEqual(['parent'])
  })

  it('组按日期升序，输入顺序打乱也升序', () => {
    const tasks = [
      makeTask({ id: 'c', title: 'C', plannedDay: '2026-11-20' }),
      makeTask({ id: 'a', title: 'A', plannedDay: '2026-11-05' }),
      makeTask({ id: 'b', title: 'B', plannedDay: '2026-11-11' })
    ]
    expect(groupByPlanDay(tasks).map(g => g.day)).toEqual([
      '2026-11-05',
      '2026-11-11',
      '2026-11-20'
    ])
  })

  it('组内按 sortKey 升序', () => {
    const tasks = [
      makeTask({ id: 'b', title: 'B', plannedDay: '2026-11-15', sortKey: 2048 }),
      makeTask({ id: 'a', title: 'A', plannedDay: '2026-11-15', sortKey: 1024 })
    ]
    expect(groupByPlanDay(tasks)[0].tasks.map(t => t.id)).toEqual(['a', 'b'])
  })
})
