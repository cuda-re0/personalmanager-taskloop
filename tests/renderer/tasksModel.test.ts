import { describe, expect, it } from 'vitest'
import type { Occurrence, Task } from '@shared/types/domain'
import { pointsConfigOf } from '../../src/renderer/main/features/chat/chatViewModel'
import {
  compareTasks,
  groupTasks,
  isStepChecked,
  remainingLabel
} from '../../src/renderer/main/features/tasks/tasksModel'

/** 右栏①的纯模型（04 §4①）。造数器只填排序/分组/格式化用到的字段 */
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
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...seed
  }
}

function makeOccurrence(seed: Partial<Occurrence> & Pick<Occurrence, 'id' | 'taskId' | 'day'>): Occurrence {
  return {
    status: 'pending',
    pointsAwarded: null,
    completedAt: null,
    note: null,
    ...seed
  }
}

describe('compareTasks（04 §4① 组内排序）', () => {
  it('doing 优先于 todo', () => {
    const a = makeTask({ id: 'a', type: 'deadline', title: 'A', status: 'doing' })
    const b = makeTask({ id: 'b', type: 'deadline', title: 'B' })
    expect([b, a].sort(compareTasks).map(t => t.id)).toEqual(['a', 'b'])
  })

  it('priority 降序', () => {
    const a = makeTask({ id: 'a', type: 'deadline', title: 'A', priority: 2 })
    const b = makeTask({ id: 'b', type: 'deadline', title: 'B', priority: 0 })
    expect([b, a].sort(compareTasks).map(t => t.id)).toEqual(['a', 'b'])
  })

  it('时间升序，null 最后', () => {
    const early = makeTask({ id: 'early', type: 'deadline', title: 'A', dueAt: '2026-11-01T00:00:00.000Z' })
    const late = makeTask({ id: 'late', type: 'deadline', title: 'B', dueAt: '2026-11-09T00:00:00.000Z' })
    const noDate = makeTask({ id: 'none', type: 'deadline', title: 'C', dueAt: null })
    expect([late, noDate, early].sort(compareTasks).map(t => t.id)).toEqual(['early', 'late', 'none'])
  })

  it('同级内按 sortKey', () => {
    const a = makeTask({ id: 'a', type: 'deadline', title: 'A', sortKey: 1024 })
    const b = makeTask({ id: 'b', type: 'deadline', title: 'B', sortKey: 2048 })
    expect([b, a].sort(compareTasks).map(t => t.id)).toEqual(['a', 'b'])
  })
})

describe('groupTasks（三组分列）', () => {
  it('每日组只收 pending 的今日 occurrence，限时/活动按类型分列，子任务不单列', () => {
    const dailyTask = makeTask({ id: 't-daily', type: 'daily', title: '背单词', sortKey: 1 })
    const step = makeTask({ id: 't-step', type: 'deadline', title: '步骤', parentId: 't-deadline' })
    const deadlineTask = makeTask({ id: 't-deadline', type: 'deadline', title: '交作业', sortKey: 2 })
    const eventTask = makeTask({ id: 't-event', type: 'event', title: '考试', sortKey: 3 })
    const tasks = [step, deadlineTask, eventTask, dailyTask]
    const occurrences = [
      makeOccurrence({ id: 'o-1', taskId: 't-daily', day: '2026-10-28' }),
      makeOccurrence({ id: 'o-2', taskId: 't-daily', day: '2026-10-28', status: 'done' })
    ]

    const groups = groupTasks(tasks, occurrences, '2026-10-28')
    expect(groups.daily.map(r => r.occurrence.id)).toEqual(['o-1'])
    expect(groups.daily[0].task?.id).toBe('t-daily')
    expect(groups.deadline.map(t => t.id)).toEqual(['t-deadline'])
    expect(groups.event.map(t => t.id)).toEqual(['t-event'])
  })

  it('v0.21 防回归：同一每日任务在 今天~+3 天 各一条 occurrence，每日组只出现今天那一行', () => {
    const dailyTask = makeTask({ id: 't-daily', type: 'daily', title: '写季度复盘初稿', sortKey: 1 })
    // ensureRange(今天, +3天) 预生成的真实形态：4 条 pending，只有 day 不同
    const occurrences = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].map((day, i) =>
      makeOccurrence({ id: `o-${i}`, taskId: 't-daily', day })
    )

    const groups = groupTasks([dailyTask], occurrences, '2026-10-28')
    expect(groups.daily.length).toBe(1)
    expect(groups.daily[0].occurrence.day).toBe('2026-10-28')
  })
})

describe('remainingLabel（04 §4① 剩余时间）', () => {
  const now = new Date('2026-10-28T10:00:00+08:00')

  it('限时：<24h 显示小时，跨到明天显示「明天」，更远显示天数', () => {
    const h = makeTask({ id: 'a', type: 'deadline', title: 'A', dueAt: '2026-10-28T16:00:00+08:00' })
    expect(remainingLabel(h, now)).toBe('6h')
    const tomorrow = makeTask({ id: 'b', type: 'deadline', title: 'B', dueAt: '2026-10-29T11:00:00+08:00' })
    expect(remainingLabel(tomorrow, now)).toBe('明天')
    const days = makeTask({ id: 'c', type: 'deadline', title: 'C', dueAt: '2026-10-31T10:00:00+08:00' })
    expect(remainingLabel(days, now)).toBe('3d')
  })

  it('已过期为「逾期」；活动显示天数；无 dueAt / daily 返回空', () => {
    const overdue = makeTask({ id: 'a', type: 'deadline', title: 'A', dueAt: '2026-10-27T10:00:00+08:00' })
    expect(remainingLabel(overdue, now)).toBe('逾期')
    const event = makeTask({ id: 'b', type: 'event', title: 'B', dueAt: '2026-11-04T10:00:00+08:00' })
    expect(remainingLabel(event, now)).toBe('7d')
    const noDate = makeTask({ id: 'c', type: 'deadline', title: 'C', dueAt: null })
    expect(remainingLabel(noDate, now)).toBe('')
    const daily = makeTask({ id: 'd', type: 'daily', title: 'D' })
    expect(remainingLabel(daily, now)).toBe('')
  })
})

describe('pointsConfigOf（02 §5.2b：settings 的 points.* → 完整 PointsConfig）', () => {
  it('四个字段全部取自 settings，不许只传 dailyBase', () => {
    const cfg = pointsConfigOf({
      'ai.provider': { name: 'zhipu', model: 'glm-5.3-flash' },
      'hud.mode': 'dock-bar',
      'hud.displayId': null,
      'hud.position': { x: null, y: null },
      'hud.expanded': { 'dock-bar': false, 'float-pod': false },
      'hud.autoHideFullscreen': true,
      'points.difficultyBase': { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
      'points.dailyBase': 1,
      'points.streakBonus': [{ days: 7, bonus: 5 }],
      'points.dailyCap': null,
      'reminder.quietHours': { from: '22:00', to: '08:00' },
      'reminder.channels': ['inapp'],
      'channel.mail': null,
      'channel.webhook': null,
      'app.theme': 'light'
    })
    expect(cfg).toEqual({
      difficultyBase: { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
      dailyBase: 1,
      streakBonus: [{ days: 7, bonus: 5 }],
      dailyCap: null
    })
  })
})

describe('isStepChecked', () => {
  it('勾选 = 状态离开 todo', () => {
    expect(isStepChecked(makeTask({ id: 'a', type: 'deadline', title: 'A' }))).toBe(false)
    expect(
      isStepChecked(makeTask({ id: 'b', type: 'deadline', title: 'B', status: 'doing' }))
    ).toBe(true)
  })
})
