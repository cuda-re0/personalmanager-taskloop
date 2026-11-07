import { describe, expect, it } from 'vitest'
import type { Occurrence, Task } from '@shared/types/domain'
import {
  buildRows,
  completionRatio,
  composeHudBg,
  hudDueLabel,
  localDayOf,
  pendingCount,
  ratioLabel,
  tempLabel,
  todayPointsLabel,
  weekdayLabel,
  withinHudWindow
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
        completable: true,
        dueLabel: ''
      },
      {
        kind: 'task',
        id: 'e1',
        title: '限时B',
        done: false,
        type: 'deadline',
        completable: false,
        dueLabel: ''
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

  it('missed 与已完成同档：沉底 + 变淡 + 不可完成（04 §5.3 v0.39）', () => {
    const tasks = [
      makeTask({ id: 'missed', title: '判失败', status: 'missed', dueAt: '2026-10-30T08:00:00' }),
      makeTask({ id: 'open', title: '未完成', dueAt: '2026-10-31T08:00:00' })
    ]
    const rows = buildRows([], tasks)
    expect(rows.map(r => r.id)).toEqual(['open', 'missed'])
    expect(rows[1]).toMatchObject({ done: true, completable: false })
  })

  it('done 与 missed 同档：两者都排在未完成行之后', () => {
    const tasks = [
      makeTask({ id: 'done', title: '完成', status: 'done', dueAt: '2026-10-30T08:00:00' }),
      makeTask({ id: 'missed', title: '失败', status: 'missed', dueAt: '2026-10-30T09:00:00' }),
      makeTask({ id: 'open', title: '未完成', dueAt: '2026-10-30T10:00:00' })
    ]
    const ids = buildRows([], tasks).map(r => r.id)
    expect(ids[0]).toBe('open')
    expect(new Set(ids.slice(1))).toEqual(new Set(['done', 'missed']))
  })
})

describe('悬浮窗窗口：今天 ~ 今天+7（含两端）', () => {
  const TODAY = '2026-10-28'

  it('8 天后的任务丢掉，今天与第 7 天留下；行尾日期是 MM-DD', () => {
    const tasks = [
      makeTask({ id: 'today', title: '今天', dueAt: '2026-10-28' }),
      makeTask({ id: 'd7', title: '第七天', dueAt: '2026-11-04' }),
      makeTask({ id: 'd8', title: '第八天', dueAt: '2026-11-05' })
    ]
    expect(withinHudWindow(tasks, TODAY).map(t => t.id)).toEqual(['today', 'd7'])
    expect(hudDueLabel('2026-11-04T09:00:00')).toBe('11-04')
    expect(hudDueLabel('2026-11')).toBe('11-30')
    expect(hudDueLabel(null)).toBe('')
    expect(hudDueLabel('不是日期')).toBe('')
  })

  it('done / missed 只保留今天结束的（看 updatedAt，不看 dueAt）', () => {
    const tasks = [
      // ①今天结束的 → 保留
      makeTask({
        id: 'done-today',
        title: '今天完成',
        status: 'done',
        dueAt: '2026-01-01',
        updatedAt: new Date(2026, 9, 28, 10).toISOString()
      }),
      // ②昨天结束的 → 丢弃（跨天就该沉掉）
      makeTask({
        id: 'done-yesterday',
        title: '昨天完成',
        status: 'done',
        dueAt: '2026-10-27',
        updatedAt: new Date(2026, 9, 27, 10).toISOString()
      }),
      // ③dueAt 很久以前、但今天才判失败 → 保留（判定看 updatedAt）
      makeTask({
        id: 'missed-today',
        title: '今天判失败',
        status: 'missed',
        dueAt: '2026-01-02',
        updatedAt: new Date(2026, 9, 28, 11).toISOString()
      })
    ]
    expect(withinHudWindow(tasks, TODAY).map(t => t.id)).toEqual(['done-today', 'missed-today'])
  })

  it('已结束的行不受 7 天窗口限制：dueAt 在窗口之外也留', () => {
    const tasks = [
      makeTask({
        id: 'done-far',
        title: '远的已完成',
        status: 'done',
        dueAt: '2026-12-31',
        updatedAt: new Date(2026, 9, 28, 9).toISOString()
      })
    ]
    expect(withinHudWindow(tasks, TODAY).map(t => t.id)).toEqual(['done-far'])
  })

  it('missed 的 dueAt 在今天、updatedAt 是昨天 → 仍然丢弃（跨天优先于窗口）', () => {
    const tasks = [
      makeTask({
        id: 'missed-stale',
        title: '昨天判失败',
        status: 'missed',
        dueAt: '2026-10-28',
        updatedAt: new Date(2026, 9, 27, 23).toISOString()
      })
    ]
    expect(withinHudWindow(tasks, TODAY)).toEqual([])
  })

  it('dueAt 为 null 时保留（判不出日期不凭空丢）', () => {
    const tasks = [makeTask({ id: 'none', title: '无限期', dueAt: null })]
    expect(withinHudWindow(tasks, TODAY).map(t => t.id)).toEqual(['none'])
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

describe('长条上的温度（v0.62）', () => {
  it('有值给 `62°`，拿不到给 `--`', () => {
    expect(tempLabel(62)).toBe('62°')
    expect(tempLabel(null)).toBe('--')
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
