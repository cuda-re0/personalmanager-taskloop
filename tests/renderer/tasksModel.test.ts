import { describe, expect, it } from 'vitest'
import type { Occurrence, Task } from '@shared/types/domain'
import { duePrecisionOf } from '@shared/due'
import { pointsConfigOf } from '../../src/renderer/main/features/chat/chatViewModel'
import {
  canEditDueOf,
  compareTasks,
  dueDateValueOf,
  dueEditKindOf,
  duePatchOfParts,
  dueTimeValueOf,
  groupTasks,
  isStepChecked,
  remainingLabel,
  taskRightLabel,
  taskRightParts
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
  it('每日组收今日 pending+done（v0.27），pending 在前；限时/活动按类型分列，子任务不单列', () => {
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
    expect(groups.daily.map(r => r.occurrence.id)).toEqual(['o-1', 'o-2'])
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

describe('groupTasks 今日已完成（v0.27：保留、沉底、跨天消失）', () => {
  const today = '2026-10-28'
  /** 今天下午完成的 done 任务（UTC 06:00 = 本地 14:00，避开跨日边界） */
  const doneTodayAt = (id: string, sortKey: number, day = '2026-10-28'): Task =>
    makeTask({
      id,
      type: 'deadline',
      title: id,
      sortKey,
      status: 'done',
      completedAt: `${day}T06:00:00.000Z`
    })

  it('每日组：pending 在前、done 沉底，各段内部按原 sortKey；非今天的 done 不出现', () => {
    const task = makeTask({ id: 't-daily', type: 'daily', title: '背单词', sortKey: 1 })
    const occurrences = [
      makeOccurrence({ id: 'o-done-b', taskId: 't-daily', day: today, status: 'done' }),
      makeOccurrence({ id: 'o-pending-b', taskId: 't-daily', day: today }),
      makeOccurrence({ id: 'o-done-a', taskId: 't-daily', day: today, status: 'done' }),
      // 别的天不算（含未来预生成与过去的 done）
      makeOccurrence({ id: 'o-tomorrow', taskId: 't-daily', day: '2026-10-29' }),
      makeOccurrence({ id: 'o-yesterday-done', taskId: 't-daily', day: '2026-10-27', status: 'done' })
    ]

    const groups = groupTasks([task], occurrences, today)
    expect(groups.daily.map(r => r.occurrence.id)).toEqual(['o-pending-b', 'o-done-b', 'o-done-a'])
  })

  it('限时组：活跃行在前（原排序不动），今日 done 沉底（内部保持原排序）', () => {
    const activeLow = makeTask({ id: 'active-low', type: 'deadline', title: 'A', sortKey: 1 })
    const activeHigh = makeTask({ id: 'active-high', type: 'deadline', title: 'B', sortKey: 2 })
    const doneB = doneTodayAt('done-b', 3)
    const doneA = doneTodayAt('done-a', 4)

    const groups = groupTasks([doneB, activeLow, doneA, activeHigh], [], today)
    expect(groups.deadline.map(t => t.id)).toEqual(['active-low', 'active-high', 'done-b', 'done-a'])
  })

  it('跨天消失：completedAt 为昨天的 done 任务不进分组结果（靠过滤，无清理逻辑）', () => {
    const yesterday = doneTodayAt('done-old', 1, '2026-10-27')

    const groups = groupTasks([yesterday], [], today)
    expect(groups.deadline).toEqual([])
    expect(groups.event).toEqual([])
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

describe('taskRightLabel（v0.59：剩余 · 目标 一行）', () => {
  const now = new Date('2026-11-01T06:00:00.000Z')

  it('活动 + 分钟级 due → 剩余在前、目标在后', () => {
    const task = makeTask({
      id: 'a',
      type: 'event',
      title: 'A',
      dueAt: '2026-11-03T06:00:00.000Z'
    })
    expect(taskRightLabel(task, now)).toBe('2d · 11-03 14:00')
  })

  it('限时 + 日期级 due → 目标只到日期，不编一个时刻', () => {
    const task = makeTask({ id: 'b', type: 'deadline', title: 'B', dueAt: '2026-11-02' })
    expect(taskRightLabel(task, now)).toBe('明天 · 11-02')
  })

  it('每日任务没有 dueAt → 空', () => {
    const task = makeTask({ id: 'c', type: 'daily', title: 'C', dueAt: null })
    expect(taskRightLabel(task, now)).toBe('')
  })

  it('已完成的限时任务 → 空（不画分隔符、不留半个值）', () => {
    const task = makeTask({
      id: 'd',
      type: 'deadline',
      title: 'D',
      status: 'done',
      dueAt: '2026-11-05T06:00:00.000Z'
    })
    expect(taskRightLabel(task, now)).toBe('')
  })
})

describe('canEditDueOf（v0.65）', () => {
  it('活动与限时的 todo / doing 可改日期，其余一律不可', () => {
    const minute = '2026-11-13T09:00:00.000Z'
    expect(canEditDueOf(makeTask({ id: 'a', type: 'event', title: 'A', dueAt: minute }))).toBe(true)
    expect(
      canEditDueOf(makeTask({ id: 'b', type: 'event', title: 'B', status: 'doing', dueAt: minute }))
    ).toBe(true)
    expect(
      canEditDueOf(makeTask({ id: 'c', type: 'event', title: 'C', status: 'done', dueAt: minute }))
    ).toBe(false)
    expect(
      canEditDueOf(makeTask({ id: 'd', type: 'deadline', title: 'D', dueAt: '2026-11-03' }))
    ).toBe(true)
    expect(
      canEditDueOf(
        makeTask({ id: 'f', type: 'deadline', title: 'F', status: 'done', dueAt: '2026-11-03' })
      )
    ).toBe(false)
    expect(canEditDueOf(makeTask({ id: 'e', type: 'daily', title: 'E' }))).toBe(false)
  })
})

describe('dueEditKindOf / dueDateValueOf / dueTimeValueOf（v0.75）', () => {
  it('minute 取本地日期与时刻，day 只给日期（时间必须空），month / null 两个框都空', () => {
    expect(dueEditKindOf('2026-11-13T09:00:00.000Z')).toBe('minute')
    expect(dueEditKindOf('2026-11-03')).toBe('day')
    expect(dueEditKindOf('2026-11')).toBeNull()
    expect(dueEditKindOf(null)).toBeNull()

    // day 精度：日期原样、时间必须是空串（不许补 23:59，也不许绕 Date 串日）
    expect(dueDateValueOf('2026-11-03')).toBe('2026-11-03')
    expect(dueTimeValueOf('2026-11-03')).toBe('')

    // minute 的期望值现算，换时区跑也不红
    const minute = new Date(2026, 10, 13, 14, 30).toISOString()
    expect(dueDateValueOf(minute)).toBe('2026-11-13')
    expect(dueTimeValueOf(minute)).toBe('14:30')

    expect(dueDateValueOf('2026-11')).toBe('')
    expect(dueTimeValueOf('2026-11')).toBe('')
    expect(dueDateValueOf(null)).toBe('')
    expect(dueTimeValueOf(null)).toBe('')
  })
})

describe('duePatchOfParts（v0.75：日期 + 时间 → 写库的 dueAt）', () => {
  it('时间留空写回纯日期；填了时间升级成 minute；再打开不串日、不丢时刻', () => {
    const dayOnly = duePatchOfParts('2026-11-05', '')
    expect(dayOnly).toBe('2026-11-05')
    expect(dayOnly.includes('T')).toBe(false)

    // 期望值现算，不写死 UTC 串
    const withTime = duePatchOfParts('2026-11-05', '14:30')
    expect(withTime).toBe(new Date('2026-11-05T14:30').toISOString())
    expect(duePrecisionOf(withTime)).toBe('minute')

    // 往返：输入一次、再打开就串日/丢时间，这条能挡住
    expect(dueDateValueOf(withTime)).toBe('2026-11-05')
    expect(dueTimeValueOf(withTime)).toBe('14:30')
  })
})

describe('taskRightParts（v0.65）', () => {
  const now = new Date('2026-11-01T06:00:00.000Z')

  it('活动任务未完成 → 两段分别给出；已完成 → 两段都空', () => {
    const active = makeTask({
      id: 'a',
      type: 'event',
      title: 'A',
      dueAt: '2026-11-03T06:00:00.000Z'
    })
    expect(taskRightParts(active, now)).toEqual({ remaining: '2d', due: '11-03 14:00' })

    const done = makeTask({
      id: 'b',
      type: 'event',
      title: 'B',
      status: 'done',
      dueAt: '2026-11-03T06:00:00.000Z'
    })
    expect(taskRightParts(done, now)).toEqual({ remaining: '', due: '' })
  })
})

describe('pointsConfigOf（02 §5.2b：settings 的 points.* → 完整 PointsConfig）', () => {
  it('四个字段全部取自 settings，不许只传 dailyBase', () => {
    const cfg = pointsConfigOf({
      'ai.provider': { name: 'zhipu', model: 'glm-5.3-flash' },
      'ai.chat.model': 'glm-4.7-flashx',
      'ai.baseUrl': 'https://open.bigmodel.cn/api/paas/v4',
      'hud.mode': 'ball',
      'hud.displayId': null,
      'hud.position': { x: null, y: null },
      'hud.size': null,
      'hud.background': null,
      'hud.opacity': 1,
      'hud.autoHideFullscreen': true,
      'points.difficultyBase': { trivial: 5, easy: 10, medium: 20, hard: 35, epic: 50 },
      'points.deadlineBase': { easy: 2, medium: 3, hard: 5 },
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
      deadlineBase: { easy: 2, medium: 3, hard: 5 },
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
