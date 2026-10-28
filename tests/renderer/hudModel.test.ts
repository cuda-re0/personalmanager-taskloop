import { describe, expect, it } from 'vitest'
import type { Occurrence, Task } from '@shared/types/domain'
import {
  buildRows,
  completionRatio,
  localDayOf,
  pendingCount,
  ratioLabel,
  recentTitle,
  todayPointsLabel
} from '../../src/renderer/hud/hudModel'

/** HUD 的纯模型（W9 · 04 §5）：只测计数、格式化与列表拼装，DOM 不测 */

function makeTask(seed: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    type: 'deadline',
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
    source: 'hud',
    aiConfidence: null,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...seed
  }
}

function makeOccurrence(
  seed: Partial<Occurrence> & Pick<Occurrence, 'id' | 'taskId' | 'day'>
): Occurrence {
  return {
    status: 'pending',
    pointsAwarded: null,
    completedAt: null,
    note: null,
    ...seed
  }
}

describe('完成率与计数（04 §5.2 的 ● 3/5）', () => {
  it('完成率夹在 0..1，没有每日任务时不除零', () => {
    expect(completionRatio(0, 0)).toBe(0)
    expect(completionRatio(3, 5)).toBe(0.6)
    expect(completionRatio(7, 5)).toBe(1)
    expect(ratioLabel(3, 5)).toBe('3/5')
    expect(ratioLabel(0, 0)).toBe('0/0')
  })

  it('待办角标 = 未打卡 + 未完成', () => {
    const occurrences = [
      makeOccurrence({ id: 'o1', taskId: 't1', day: '2026-10-28', status: 'done' }),
      makeOccurrence({ id: 'o2', taskId: 't2', day: '2026-10-28' }),
      makeOccurrence({ id: 'o3', taskId: 't3', day: '2026-10-28', status: 'skipped' })
    ]
    const tasks = [
      makeTask({ id: 'a', title: 'A' }),
      makeTask({ id: 'b', title: 'B', status: 'doing' })
    ]
    // skipped 不算待办；两条活跃任务各算一条
    expect(pendingCount(occurrences, tasks)).toBe(3)
  })
})

describe('今日积分格式（04 §5.2 的 今日 +42）', () => {
  it('正数带 +，负数用负号，小数最多 2 位（与 04 §4③ 同口径）', () => {
    expect(todayPointsLabel(42)).toBe('今日 +42')
    expect(todayPointsLabel(11.5)).toBe('今日 +11.5')
    expect(todayPointsLabel(0)).toBe('今日 0')
    expect(todayPointsLabel(-10)).toBe('今日 -10')
  })

  it('本地日历日不受时区影响（不用 toISOString）', () => {
    expect(localDayOf(new Date(2026, 9, 28, 23, 59))).toBe('2026-10-28')
    expect(localDayOf(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})

describe('列表拼装（每日打卡在前，限时/活动在后，最多 6 条）', () => {
  const occurrences = [
    makeOccurrence({ id: 'o1', taskId: 't1', day: '2026-10-28', taskTitle: '报告初稿' }),
    makeOccurrence({
      id: 'o2',
      taskId: 't2',
      day: '2026-10-28',
      status: 'done',
      taskTitle: '客户回访'
    })
  ]
  const tasks = [
    makeTask({ id: 'a', title: '报销单' }),
    makeTask({ id: 'b', title: '季度复盘' }),
    makeTask({ id: 'c', title: '合同归档' }),
    makeTask({ id: 'd', title: '预算表' }),
    makeTask({ id: 'e', title: '招聘需求' })
  ]

  it('每日在前、任务在后，完成的打卡仍留在列表里（与 3/5 对得上）', () => {
    const rows = buildRows(occurrences, tasks)
    expect(rows.map(r => r.id)).toEqual(['o1', 'o2', 'a', 'b', 'c', 'd'])
    expect(rows[1]).toEqual({ kind: 'occurrence', id: 'o2', title: '客户回访', done: true })
  })

  it('最近待办标题取第一条未完成的；全完成则退回第一条', () => {
    expect(recentTitle(buildRows(occurrences, tasks))).toBe('报告初稿')
    const allDone = buildRows(
      [makeOccurrence({ id: 'o1', taskId: 't1', day: '2026-10-28', status: 'done', taskTitle: 'X' })],
      []
    )
    expect(recentTitle(allDone)).toBe('X')
    expect(recentTitle([])).toBeNull()
  })
})
