import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Occurrence, Task } from '../../src/shared/types/domain'
import { addDays, nowIso, todayLocalDay } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
import * as pointsService from '../../src/main/services/pointsService'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

/**
 * 铺出「截至今天的 N 天」occurrence。
 * ensureRange 只补今天及以后（01 §2.1.3 不回溯），历史用 insertIfAbsent 直接铺——
 * 这也正是调度器/补数据那条路径用的函数。
 */
function dailyWithDays(count: number): { task: Task; days: string[] } {
  const task = taskService.createTask({ type: 'daily', title: '背单词', source: 'manual' })
  const today = todayLocalDay()
  const days: string[] = []
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = addDays(today, -i)
    occurrenceRepo.insertIfAbsent(task.id, day, nowIso())
    days.push(day)
  }
  return { task, days }
}

function occOf(taskId: string, day: string): Occurrence {
  const found = occurrenceRepo.listByTask(taskId).find(o => o.day === day)
  if (!found) throw new Error(`没有 ${day} 的 occurrence`)
  return found
}

describe('occurrence.complete（每日这一次）', () => {
  it('第一次完成 → streak 1、task_done +1、无里程碑、occurrence 落 done', () => {
    const { task, days } = dailyWithDays(1)
    const result = pointsService.awardOccurrence(occOf(task.id, days[0]).id)

    expect(result.streakAfter).toBe(1)
    expect(result.entry.delta).toBe(1)
    expect(result.entry.reasonCode).toBe('task_done')
    expect(result.entry.occurrenceId).toBe(result.occurrence.id)
    expect(result.occurrence.status).toBe('done')
    expect(result.occurrence.pointsAwarded).toBe(1)
    expect(result.occurrence.completedAt).not.toBeNull()
    expect(result.task.streakCurrent).toBe(1)
    expect(result.task.streakBest).toBe(1)
    expect(ledgerRepo.countAll()).toBe(1)
    expect(pointsService.balance()).toBe(1)
    expect(statsRepo.getDay(days[0]).occurrencesDone).toBe(1)
  })

  it('连做 7 天 → 第 7 天两条明细：task_done +1 与 streak_bonus +5', () => {
    const { task, days } = dailyWithDays(7)
    for (const day of days) pointsService.awardOccurrence(occOf(task.id, day).id)

    const last = occOf(task.id, days[6])
    expect(last.status).toBe('done')
    // 单日实得 = 基础分 + 里程碑奖励
    expect(last.pointsAwarded).toBe(6)

    const lastDayEntries = ledgerRepo.list({ from: days[6], to: days[6] })
    expect(lastDayEntries.map(e => [e.reasonCode, e.delta])).toEqual(
      expect.arrayContaining([
        ['task_done', 1],
        ['streak_bonus', 5]
      ])
    )
    // 里程碑那条不能带 occurrence_id：uq_ledger_occurrence 只允许每个 occurrence 一条
    const bonus = lastDayEntries.find(e => e.reasonCode === 'streak_bonus')
    expect(bonus?.occurrenceId).toBeNull()

    const after = taskService.requireTask(task.id)
    expect(after.streakCurrent).toBe(7)
    expect(after.streakBest).toBe(7)
    expect(pointsService.balance()).toBe(12)
  })

  it('第 8 天漏做、第 9 天完成 → streak_current = 1 且不给里程碑', () => {
    const { task, days } = dailyWithDays(9)
    // days[0..6] 连做 7 天，days[7] 漏做（次日 00:05 落 missed），days[8] 是今天
    for (const day of days.slice(0, 7)) pointsService.awardOccurrence(occOf(task.id, day).id)
    expect(taskService.requireTask(task.id).streakCurrent).toBe(7)

    occurrenceRepo.markMissedBefore(todayLocalDay(), nowIso())
    expect(occOf(task.id, days[7]).status).toBe('missed')

    const result = pointsService.awardOccurrence(occOf(task.id, days[8]).id)
    expect(result.streakAfter).toBe(1)

    const after = taskService.requireTask(task.id)
    expect(after.streakCurrent).toBe(1)
    // 历史最高不回退
    expect(after.streakBest).toBe(7)
    expect(ledgerRepo.list({ from: days[8], to: days[8] }).map(e => e.reasonCode)).toEqual([
      'task_done'
    ])
  })

  it('同一天重复完成 → CONFLICT，库中无第二条流水', () => {
    const { task, days } = dailyWithDays(1)
    const occ = occOf(task.id, days[0])
    pointsService.awardOccurrence(occ.id)

    expectErrorCode(() => pointsService.awardOccurrence(occ.id), 'CONFLICT')
    expect(ledgerRepo.countAll()).toBe(1)
    expect(pointsService.balance()).toBe(1)
  })
})

describe('occurrence.undo', () => {
  it('撤销第 7 天 → streak 回 6，里程碑那条被冲销', () => {
    const { task, days } = dailyWithDays(7)
    for (const day of days) pointsService.awardOccurrence(occOf(task.id, day).id)
    expect(pointsService.balance()).toBe(12)

    const result = pointsService.undoOccurrence(occOf(task.id, days[6]).id)

    expect(result.occurrence.status).toBe('pending')
    expect(result.occurrence.pointsAwarded).toBeNull()
    expect(result.occurrence.completedAt).toBeNull()
    expect(result.task.streakCurrent).toBe(6)
    expect(result.task.streakBest).toBe(7)
    // 冲销后余额 = 6×1 + 5(bonus 仍在) − 1 − 5(bonus 冲销) = 6
    expect(pointsService.balance()).toBe(6)
    expect(result.balanceAfter).toBe(6)
    // 冲销行是 adjust 且不带 occurrence_id，不撞条件唯一索引
    const rollbacks = ledgerRepo
      .list({ from: days[6], to: days[6] })
      .filter(e => e.reasonCode === 'manual_adjust')
    expect(rollbacks.map(e => e.delta)).toEqual(expect.arrayContaining([-1, -5]))
    expect(rollbacks.every(e => e.occurrenceId === null)).toBe(true)
    expect(statsRepo.getDay(days[6]).occurrencesDone).toBe(0)
  })

  it('撤销未完成的那一天是 no-op：不写流水、状态仍 pending', () => {
    const { task, days } = dailyWithDays(1)
    const result = pointsService.undoOccurrence(occOf(task.id, days[0]).id)

    expect(result.occurrence.status).toBe('pending')
    expect(result.balanceAfter).toBe(0)
    expect(ledgerRepo.countAll()).toBe(0)
  })
})

describe('occurrence.skip', () => {
  it('跳过不计分、不动 streak、不写流水', () => {
    const { task, days } = dailyWithDays(1)
    const skipped = pointsService.skipOccurrence(occOf(task.id, days[0]).id, '今天加班')

    expect(skipped.status).toBe('skipped')
    expect(skipped.note).toBe('今天加班')
    expect(skipped.pointsAwarded).toBeNull()
    expect(ledgerRepo.countAll()).toBe(0)
    expect(pointsService.balance()).toBe(0)
    expect(taskService.requireTask(task.id).streakCurrent).toBe(0)
    expect(statsRepo.getDay(days[0]).occurrencesDone).toBe(0)
  })

  it('已完成的打卡不会退回跳过（先撤销再跳）', () => {
    const { task, days } = dailyWithDays(1)
    const occ = occOf(task.id, days[0])
    pointsService.awardOccurrence(occ.id)

    const after = pointsService.skipOccurrence(occ.id)
    expect(after.status).toBe('done')
    expect(pointsService.balance()).toBe(1)
  })
})

describe('已删任务的打卡拦截（v0.85）', () => {
  it('已丢弃的任务不能打卡：CONFLICT 且余额不变', () => {
    const { task, days } = dailyWithDays(1)
    const occ = occOf(task.id, days[0])
    // 不用 removeTask：它会清掉今天这条未完成行（§1），award 会先撞 NOT_FOUND。
    // 按 §9 验收 3 的口径直接把任务标成 discarded，让 occurrence 留在库里，才真正打到状态闸。
    taskRepo.updateColumns(task.id, { status: 'discarded' }, nowIso())

    expectErrorCode(() => pointsService.awardOccurrence(occ.id), 'CONFLICT')
    expect(ledgerRepo.balance()).toBe(0)
    expect(pointsService.balance()).toBe(0)
  })

  it('删除只清未完成行：今天的 done 保留、未来的 pending 清掉', () => {
    const { task, days } = dailyWithDays(1)
    pointsService.awardOccurrence(occOf(task.id, days[0]).id)
    const tomorrow = addDays(todayLocalDay(), 1)
    occurrenceRepo.insertIfAbsent(task.id, tomorrow, nowIso())

    taskService.removeTask(task.id)

    const left = occurrenceRepo.listByTask(task.id)
    expect(left.map(o => [o.day, o.status])).toEqual([[days[0], 'done']])
  })
})
