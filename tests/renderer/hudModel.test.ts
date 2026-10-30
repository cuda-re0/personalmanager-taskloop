import { describe, expect, it } from 'vitest'
import type { Occurrence, Task } from '@shared/types/domain'
import {
  buildRows,
  completionRatio,
  composeHudBg,
  localDayOf,
  pendingCount,
  ratioLabel,
  todayPointsLabel,
  weekdayLabel
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

describe('列表拼装（完成沉底 → 每日 → 限时 → 活动，04 §5.3 v0.38）', () => {
  it('每日任务不进任务行（否则同标题两行，任务行点完成会被服务端拒绝）', () => {
    const daily = makeTask({ id: 'd1', title: '每日A', type: 'daily' })
    const deadline = makeTask({ id: 'e1', title: '限时B' })
    const rows = buildRows(
      [makeOccurrence({ id: 'o1', taskId: 'd1', day: '2026-10-28', taskTitle: '每日A' })],
      [daily, deadline]
    )
    expect(rows).toEqual([
      {
        kind: 'occurrence',
        id: 'o1',
        title: '每日A',
        done: false,
        type: 'daily',
        completable: true
      },
      {
        kind: 'task',
        id: 'e1',
        title: '限时B',
        done: false,
        type: 'deadline',
        completable: false
      }
    ])
  })

  it('顺序：每日① 每日② 限时 活动 已完成限时（不再截断到 6 条）', () => {
    const occurrences = [
      makeOccurrence({ id: 'o1', taskId: 't1', day: '2026-10-30', taskTitle: '每日①' }),
      makeOccurrence({ id: 'o2', taskId: 't2', day: '2026-10-30', taskTitle: '每日②' })
    ]
    const tasks = [
      makeTask({ id: 'done-dl', title: '已完成限时', status: 'done', dueAt: '2026-10-30T09:00:00' }),
      makeTask({ id: 'ev', title: '活动', type: 'event', dueAt: '2026-10-31T18:00:00' }),
      makeTask({ id: 'dl', title: '限时', dueAt: '2026-10-30T20:00:00' })
    ]
    expect(buildRows(occurrences, tasks).map(r => r.title)).toEqual([
      '每日①',
      '每日②',
      '限时',
      '活动',
      '已完成限时'
    ])
  })

  it('已完成的活动排在未完成的限时之后（沉底优先于类型档）', () => {
    const tasks = [
      makeTask({ id: 'ev', title: '活动', type: 'event', status: 'done', dueAt: '2026-10-30T08:00:00' }),
      makeTask({ id: 'dl', title: '限时', dueAt: '2026-10-31T08:00:00' })
    ]
    expect(buildRows([], tasks).map(r => r.id)).toEqual(['dl', 'ev'])
  })

  it('同档内按 dueAt 升序，dueAt 为 null 的排最后', () => {
    const tasks = [
      makeTask({ id: 'none', title: '无限期', dueAt: null }),
      makeTask({ id: 'late', title: '晚', dueAt: '2026-10-31T20:00:00' }),
      makeTask({ id: 'early', title: '早', dueAt: '2026-10-30T08:00:00' })
    ]
    expect(buildRows([], tasks).map(r => r.id)).toEqual(['early', 'late', 'none'])
  })

  it('completable：每日行为 true，限时/活动行为 false', () => {
    const rows = buildRows(
      [makeOccurrence({ id: 'o1', taskId: 'd1', day: '2026-10-30', taskTitle: '每日' })],
      [
        makeTask({ id: 'dl', title: '限时' }),
        makeTask({ id: 'ev', title: '活动', type: 'event' })
      ]
    )
    expect(rows.map(r => [r.type, r.completable])).toEqual([
      ['daily', true],
      ['deadline', false],
      ['event', false]
    ])
  })
})

describe('长条上的星期（v0.31）', () => {
  it('7 个已知日期给出 周日…周六（硬编码，不依赖 ICU）', () => {
    // 2026-10-25 是周日，连排 7 天
    const days = [
      ['2026-10-25', '周日'],
      ['2026-10-26', '周一'],
      ['2026-10-27', '周二'],
      ['2026-10-28', '周三'],
      ['2026-10-29', '周四'],
      ['2026-10-30', '周五'],
      ['2026-10-31', '周六']
    ] as const
    for (const [day, label] of days) {
      expect(weekdayLabel(new Date(`${day}T12:00:00`))).toBe(label)
    }
  })
})

describe('背景合成（04 §5.4 v0.30：透明度只进 alpha）', () => {
  it('hud.background 为空时取主题底色，alpha 就是透明度', () => {
    expect(composeHudBg(null, 0.5, '#ffffff')).toBe('rgba(255, 255, 255, 0.5)')
    expect(composeHudBg(null, 1, '#ffffff')).toBe('rgba(255, 255, 255, 1)')
  })

  it('自定义颜色按 #rrggbb / #rgb 解析，透明度夹在 0..1', () => {
    expect(composeHudBg('#1f2f3f', 0.7, '#ffffff')).toBe('rgba(31, 47, 63, 0.7)')
    expect(composeHudBg('#fff', 0.4, '#000000')).toBe('rgba(255, 255, 255, 0.4)')
    expect(composeHudBg('#1f2f3f', 2, '#ffffff')).toBe('rgba(31, 47, 63, 1)')
  })

  it('认不出的颜色退回白色，不抛错', () => {
    expect(composeHudBg('red', 1, 'rgb(0,0,0)')).toBe('rgba(255, 255, 255, 1)')
  })
})
