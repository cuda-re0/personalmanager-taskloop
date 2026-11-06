import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  dayDiff,
  isoWeekday,
  nowIso,
  todayLocalDay
} from '../../src/main/db/localDay'
import { OCCURRENCE_HORIZON_MONTHS, ensureRange, listToday } from '../../src/main/db/occurrenceService'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, openMemoryDb } from './helpers'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('ensureRange', () => {
  it('一条非法 repeat_rule 只跳过它自己，其它任务照常补齐（v0.83）', () => {
    const broken = taskService.createTask({ type: 'daily', title: '坏规则' })
    // createTask 会拦非法值，这里直接改列模拟历史脏数据
    taskRepo.updateColumns(broken.id, { repeat_rule: 'GARBAGE' }, new Date().toISOString())
    const good = taskService.createTask({ type: 'daily', title: '好规则' })

    const today = todayLocalDay()
    const result = ensureRange(today, addDays(today, 2))

    expect(occurrenceRepo.countByTask(broken.id)).toBe(0)
    expect(occurrenceRepo.countByTask(good.id)).toBe(3)
    expect(result.created).toBe(3)
    expect(() => listToday()).not.toThrow()
  })

  it('连续调用 3 次，occurrence 数量不增长（幂等）', () => {
    const daily = taskService.createTask({ type: 'daily', title: '跑步' })
    const today = todayLocalDay()

    const first = ensureRange(today, addDays(today, 6))
    const countAfterFirst = occurrenceRepo.countByTask(daily.id)
    expect(first.created).toBe(countAfterFirst)
    expect(countAfterFirst).toBe(7)

    const second = ensureRange(today, addDays(today, 6))
    const third = ensureRange(today, addDays(today, 6))
    expect(second.created).toBe(0)
    expect(third.created).toBe(0)
    expect(occurrenceRepo.countByTask(daily.id)).toBe(countAfterFirst)
  })

  it('daily 的同类型子任务不生成 occurrence（v0.15：listDailyActive 排除 parent_id 非空）', () => {
    const parent = taskService.createTask({ type: 'daily', title: '背单词' })
    const sub = taskService.createTask({
      type: 'daily',
      title: '背单词·步骤',
      parentId: parent.id
    })
    const today = todayLocalDay()

    const first = ensureRange(today, addDays(today, 6))

    // 子任务未被排除时这里会是 14
    expect(first.created).toBe(7)
    expect(occurrenceRepo.countByTask(parent.id)).toBe(7)
    expect(occurrenceRepo.countByTask(sub.id)).toBe(0)
  })

  it('不生成过去日期：区间从 2020 年开始也只补今天', () => {
    const daily = taskService.createTask({
      type: 'daily',
      title: '背单词',
      activeFrom: '2020-01-01'
    })
    const today = todayLocalDay()

    const result = ensureRange('2020-01-01', today)
    expect(result.range.from).toBe(today)
    const days = occurrenceRepo.listByTask(daily.id).map(o => o.day)
    expect(days).toEqual([today])
    expect(days.every(d => d >= today)).toBe(true)
  })

  it('不生成 active_to 之后的日期', () => {
    const today = todayLocalDay()
    const daily = taskService.createTask({
      type: 'daily',
      title: '限时习惯',
      activeFrom: addDays(today, -10),
      activeTo: addDays(today, 2)
    })

    ensureRange(today, addDays(today, 30))
    const days = occurrenceRepo.listByTask(daily.id).map(o => o.day)
    expect(days).toEqual([today, addDays(today, 1), addDays(today, 2)])
  })

  it('不生成今天 + 3 个月之后的日期', () => {
    const today = todayLocalDay()
    const daily = taskService.createTask({ type: 'daily', title: '长期习惯', activeFrom: '2026-01-01' })

    ensureRange(today, addDays(today, 400))
    const days = occurrenceRepo.listByTask(daily.id).map(o => o.day)
    const horizon = addMonths(today, OCCURRENCE_HORIZON_MONTHS)
    expect(days[days.length - 1]).toBe(horizon)
    expect(days).toHaveLength(dayDiff(today, horizon) + 1)
  })

  it('只给 daily 且 todo/doing 的任务生成；discarded / archived 跳过', () => {
    const today = todayLocalDay()
    const active = taskService.createTask({ type: 'daily', title: '在跑' })
    const discarded = taskService.createTask({ type: 'daily', title: '放弃了' })
    taskService.removeTask(discarded.id)
    const deadline = taskService.createTask({ type: 'deadline', title: '一次性' })

    ensureRange(today, today)
    expect(occurrenceRepo.countByTask(active.id)).toBe(1)
    expect(occurrenceRepo.countByTask(discarded.id)).toBe(0)
    expect(occurrenceRepo.countByTask(deadline.id)).toBe(0)
  })

  it('repeat_rule=WEEKLY 只在指定周几生成（1=周一）', () => {
    const today = todayLocalDay()
    const weekly = taskService.createTask({
      type: 'daily',
      title: '每周三次',
      repeatRule: 'WEEKLY:1,3,5',
      activeFrom: today,
      activeTo: addDays(today, 13)
    })

    ensureRange(today, addDays(today, 13))
    const days = occurrenceRepo.listByTask(weekly.id).map(o => o.day)
    expect(days.length).toBeGreaterThan(0)
    expect(days.every(d => [1, 3, 5].includes(isoWeekday(d)))).toBe(true)
  })

  it('区间夹空时什么都不做（from/to 都在未来 3 个月之外）', () => {
    const today = todayLocalDay()
    const daily = taskService.createTask({ type: 'daily', title: '远期习惯' })
    const result = ensureRange(addDays(today, 200), addDays(today, 260))
    expect(result.created).toBe(0)
    expect(occurrenceRepo.countByTask(daily.id)).toBe(0)
  })
})

describe('occurrence 日常操作', () => {
  it('listToday 会自动补齐今天的条目', () => {
    taskService.createTask({ type: 'daily', title: '喝水' })
    const today = listToday()
    expect(today).toHaveLength(1)
    expect(today[0].day).toBe(todayLocalDay())
    expect(today[0].status).toBe('pending')
    expect(today[0].taskTitle).toBe('喝水')
    expect(today[0].taskType).toBe('daily')
  })

  it('跳过与完成的状态写入', () => {
    taskService.createTask({ type: 'daily', title: '跑步' })
    const [occ] = listToday()
    const done = occurrenceRepo.update(occ.id, { status: 'done', pointsAwarded: 1, completedAt: '2026-10-28T02:00:00.000Z' }, '2026-10-28T02:00:00.000Z')
    expect(done.status).toBe('done')
    expect(done.pointsAwarded).toBe(1)
    expect(done.note).toBeNull()
  })

  it('markMissedBefore 只动今天之前的 pending', () => {
    const today = todayLocalDay()
    const daily = taskService.createTask({ type: 'daily', title: '跑步' })
    occurrenceRepo.insertIfAbsent(daily.id, addDays(today, -2), '2026-10-26T00:00:00.000Z')
    occurrenceRepo.insertIfAbsent(daily.id, today, '2026-10-28T00:00:00.000Z')

    const changed = occurrenceRepo.markMissedBefore(today, '2026-10-28T02:00:00.000Z')
    expect(changed).toBe(1)

    const byDay = new Map(occurrenceRepo.listByTask(daily.id).map(o => [o.day, o.status]))
    expect(byDay.get(addDays(today, -2))).toBe('missed')
    expect(byDay.get(today)).toBe('pending')
  })
})

describe('删除任务的打卡收尾（v0.85）', () => {
  it('删除后今日列表不再出现该任务的打卡行', () => {
    const daily = taskService.createTask({ type: 'daily', title: '要删的' })
    expect(listToday().some(o => o.taskId === daily.id)).toBe(true)

    taskService.removeTask(daily.id)

    expect(listToday().some(o => o.taskId === daily.id)).toBe(false)
  })

  it('日历保留历史：只清今天及以后的未完成行', () => {
    const today = todayLocalDay()
    const yesterday = addDays(today, -1)
    const daily = taskService.createTask({ type: 'daily', title: '带历史的' })
    occurrenceRepo.insertIfAbsent(daily.id, yesterday, nowIso())
    occurrenceRepo.insertIfAbsent(daily.id, today, nowIso())

    taskService.removeTask(daily.id)

    const mine = occurrenceRepo
      .listByRange(yesterday, today)
      .filter(o => o.taskId === daily.id)
    expect(mine.map(o => o.day)).toEqual([yesterday])
  })
})
