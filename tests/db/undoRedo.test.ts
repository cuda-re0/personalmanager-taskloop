import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Occurrence, Task } from '../../src/shared/types/domain'
import { nowIso, todayLocalDay } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import * as pointsService from '../../src/main/services/pointsService'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

/**
 * 撤销后重做（01 §2.4，v0.19）。
 *
 * 这组用例锁的是一个真实缺陷：撤销只写负流水、不标记原发分行，两条条件唯一索引
 * 又不看"是否已冲销"，于是重做时新插入的发分行必然撞索引——
 *   task 级 →「这个任务已经发过完成分了」
 *   occurrence 级 →「这一天的打卡已经发过分了」
 * 每日任务是高频路径，误点一次撤销后当天再也打不上卡。
 */

function deadlineReadyToComplete(): Task {
  const task = taskService.createTask({ type: 'deadline', title: '交作业', difficulty: 'medium' })
  taskService.transitionTask(task.id, 'doing')
  taskService.transitionTask(task.id, 'reviewing')
  // v0.38 起证据无条件必填，否则完成会撞 EVIDENCE_REQUIRED
  return taskService.addEvidence(task.id, { kind: 'text', text: '已交作业', addedAt: nowIso() })
}

/** 限时任务撤销后状态回到 `doing`（01 §3），重做要先走回 `reviewing` */
function backToReviewing(id: string): void {
  taskService.transitionTask(id, 'reviewing')
}

function dailyToday(): { task: Task; occ: Occurrence } {
  const task = taskService.createTask({ type: 'daily', title: '背单词', source: 'manual' })
  const day = todayLocalDay()
  occurrenceRepo.insertIfAbsent(task.id, day, nowIso())
  const occ = occurrenceRepo.listByTask(task.id).find(o => o.day === day)
  if (!occ) throw new Error(`没有 ${day} 的 occurrence`)
  return { task, occ }
}

describe('撤销后重做 · 限时/活动（task 级）', () => {
  it('完成 → 撤销 → 再次完成不再撞唯一索引，余额与流水都正确', () => {
    const task = deadlineReadyToComplete()

    const first = taskService.completeTask({ id: task.id, quality: 'met' })
    expect(first.entry?.delta).toBe(20)
    expect(pointsService.balance()).toBe(20)

    const undone = taskService.undoCompletion(task.id)
    expect(undone.task.status).toBe('doing')
    expect(undone.entry?.delta).toBe(-20)
    expect(pointsService.balance()).toBe(0)

    // 重做：这一步在修复前抛 CONFLICT「这个任务已经发过完成分了」
    backToReviewing(task.id)
    const second = taskService.completeTask({ id: task.id, quality: 'met' })

    expect(second.task.status).toBe('done')
    expect(second.entry?.delta).toBe(20)
    expect(pointsService.balance()).toBe(20)
    // 三条流水：+20、-20、+20；但有效的 task_done 只有一条
    expect(ledgerRepo.countAll()).toBe(3)
    expect(ledgerRepo.hasTaskDoneEntry(task.id)).toBe(true)
  })

  it('冲销只打时间戳、不改金额：被冲销的行仍留在流水里可供审计', () => {
    const task = deadlineReadyToComplete()
    taskService.completeTask({ id: task.id, quality: 'met' })
    taskService.undoCompletion(task.id)

    const entries = ledgerRepo.listByTask(task.id)
    const original = entries.find(e => e.reasonCode === 'task_done')
    expect(original).toBeDefined()
    expect(original?.delta).toBe(20) // 金额没被改
    expect(original?.reversedAt).not.toBeNull() // 只是被标记
    // 冲销行本身不占用任何"有效发分"的坑位
    const rollbackEntry = entries.find(e => e.reasonCode === 'manual_adjust')
    expect(rollbackEntry?.delta).toBe(-20)
    expect(rollbackEntry?.occurrenceId).toBeNull()
  })

  it('撤销后 hasTaskDoneEntry 为 false，重做后回到 true', () => {
    const task = deadlineReadyToComplete()
    taskService.completeTask({ id: task.id, quality: 'met' })
    expect(ledgerRepo.hasTaskDoneEntry(task.id)).toBe(true)

    taskService.undoCompletion(task.id)
    expect(ledgerRepo.hasTaskDoneEntry(task.id)).toBe(false)

    backToReviewing(task.id)
    taskService.completeTask({ id: task.id, quality: 'met' })
    expect(ledgerRepo.hasTaskDoneEntry(task.id)).toBe(true)
  })
})

describe('撤销后重做 · 每日任务（occurrence 级）', () => {
  it('打卡 → 撤销 → 同一天再打卡，不再撞唯一索引', () => {
    const { occ } = dailyToday()

    const first = pointsService.awardOccurrence(occ.id)
    expect(first.entry.delta).toBe(1)
    expect(pointsService.balance()).toBe(1)

    const undone = pointsService.undoOccurrence(occ.id)
    expect(undone.occurrence.status).toBe('pending')
    expect(pointsService.balance()).toBe(0)

    // 重做：修复前抛 CONFLICT「这一天的打卡已经发过分了」
    const second = pointsService.awardOccurrence(occ.id)
    expect(second.entry.delta).toBe(1)
    expect(second.occurrence.status).toBe('done')
    expect(pointsService.balance()).toBe(1)
    expect(ledgerRepo.countAll()).toBe(3)
  })

  it('撤销→重做→再撤销：只冲销当前有效的那一条，余额不会扣两次', () => {
    const { occ } = dailyToday()
    pointsService.awardOccurrence(occ.id)
    pointsService.undoOccurrence(occ.id)
    pointsService.awardOccurrence(occ.id)

    expect(pointsService.balance()).toBe(1)
    pointsService.undoOccurrence(occ.id)

    // 若 entriesOfOccurrence 不筛 reversedAt，这里会把旧行再冲一次变成 -1
    expect(pointsService.balance()).toBe(0)
    const entries = ledgerRepo.list({ from: todayLocalDay(), to: todayLocalDay() })
    expect(entries.filter(e => e.reasonCode === 'task_done' && e.reversedAt === null)).toHaveLength(0)
  })
})

describe('重复冲销防护', () => {
  it('同一条流水冲销两次 → DB_ERROR（内部故障，只进日志），不会写第二条负流水', () => {
    const { occ } = dailyToday()
    const { entry } = pointsService.awardOccurrence(occ.id)

    pointsService.rollback(entry, '第一次冲销')
    expect(pointsService.balance()).toBe(0)

    expectErrorCode(() => pointsService.rollback(entry, '第二次冲销'), 'DB_ERROR')
    expect(pointsService.balance()).toBe(0) // 没有被扣两次
  })
})
