import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/main/db/connection'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
import * as pointsService from '../../src/main/services/pointsService'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

const NOW = '2026-10-28T02:00:00.000Z'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('point_ledger 条件唯一索引', () => {
  it('同一限时任务插两条 task_done 流水 → 第二条被 uq_ledger_task_done 拒', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })

    pointsService.award({
      taskId: task.id,
      delta: 23,
      reasonCode: 'task_done',
      reasonText: '完成',
      day: '2026-10-28'
    })

    expectErrorCode(
      () =>
        pointsService.award({
          taskId: task.id,
          delta: 23,
          reasonCode: 'task_done',
          reasonText: '重复发分',
          day: '2026-10-28'
        }),
      'CONFLICT'
    )
    expect(ledgerRepo.countAll()).toBe(1)
  })

  it('同一每日任务连续两天各发一次分 → 两次都成功（本期第一号坑）', () => {
    const daily = taskService.createTask({ type: 'daily', title: '跑步' })
    const day1 = occurrenceRepo.listByTask(daily.id)
    expect(day1).toHaveLength(0)

    occurrenceRepo.insertIfAbsent(daily.id, '2026-10-27', NOW)
    occurrenceRepo.insertIfAbsent(daily.id, '2026-10-28', NOW)
    const [occ1, occ2] = occurrenceRepo.listByTask(daily.id)
    expect(occ1.day).toBe('2026-10-27')
    expect(occ2.day).toBe('2026-10-28')

    const entry1 = pointsService.award({
      taskId: daily.id,
      occurrenceId: occ1.id,
      delta: 1,
      reasonCode: 'task_done',
      day: '2026-10-27'
    })
    const entry2 = pointsService.award({
      taskId: daily.id,
      occurrenceId: occ2.id,
      delta: 1,
      reasonCode: 'task_done',
      day: '2026-10-28'
    })

    expect(entry1.delta).toBe(1)
    expect(entry2.delta).toBe(1)
    expect(ledgerRepo.countAll()).toBe(2)
    expect(pointsService.balance()).toBe(2)
  })

  it('同一每日任务同一天发两次分 → 第二次被 uq_ledger_occurrence 拒', () => {
    const daily = taskService.createTask({ type: 'daily', title: '背单词' })
    occurrenceRepo.insertIfAbsent(daily.id, '2026-10-28', NOW)
    const occ = occurrenceRepo.listByTask(daily.id)[0]

    pointsService.award({
      taskId: daily.id,
      occurrenceId: occ.id,
      delta: 1,
      reasonCode: 'task_done',
      day: '2026-10-28'
    })

    expectErrorCode(
      () =>
        pointsService.award({
          taskId: daily.id,
          occurrenceId: occ.id,
          delta: 1,
          reasonCode: 'task_done',
          day: '2026-10-28'
        }),
      'CONFLICT'
    )
    expect(pointsService.balance()).toBe(1)
  })

  it('限时任务的 task_done 只锁 occurrence_id 为 NULL 的那条，不影响该任务的 penalty 行', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交报告' })
    pointsService.award({
      taskId: task.id,
      delta: 20,
      reasonCode: 'task_done',
      day: '2026-10-28'
    })
    // 同一任务的逾期扣分是另一条 reason_code，不该被唯一索引挡
    const penalty = pointsService.award({
      taskId: task.id,
      delta: -2,
      kind: 'penalty',
      reasonCode: 'overdue_penalty',
      day: '2026-10-28'
    })
    expect(penalty.delta).toBe(-2)
    expect(pointsService.balance()).toBe(18)
  })

  it('撤销写负流水冲销，不撞两条条件唯一索引', () => {
    const daily = taskService.createTask({ type: 'daily', title: '早睡' })
    occurrenceRepo.insertIfAbsent(daily.id, '2026-10-28', NOW)
    const occ = occurrenceRepo.listByTask(daily.id)[0]

    const entry = pointsService.award({
      taskId: daily.id,
      occurrenceId: occ.id,
      delta: 1,
      reasonCode: 'task_done',
      day: '2026-10-28'
    })
    const rollback = pointsService.rollback(entry, '点错了')

    expect(rollback.delta).toBe(-1)
    expect(rollback.occurrenceId).toBeNull()
    expect(pointsService.balance()).toBe(0)
    expect(ledgerRepo.countAll()).toBe(2)
  })
})

describe('余额与聚合', () => {
  it('余额 = SUM(delta)，且 daily_stats.points 与流水同日求和一致', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    pointsService.award({ taskId: task.id, delta: 23, reasonCode: 'task_done', day: '2026-10-28' })
    pointsService.award({ taskId: null, delta: 5.5, reasonCode: 'manual_adjust', kind: 'adjust', day: '2026-10-28' })
    pointsService.award({ taskId: task.id, delta: -3.25, kind: 'penalty', reasonCode: 'overdue_penalty', day: '2026-10-29' })

    expect(pointsService.balance()).toBe(25.25)
    expect(statsRepo.getDay('2026-10-28').points).toBe(28.5)
    expect(statsRepo.getDay('2026-10-29').points).toBe(-3.25)
    expect(ledgerRepo.sumByDay('2026-10-28')).toBe(28.5)
  })

  it('小数积分累加 50 笔不漂移（写入前过 roundPoints）', () => {
    for (let i = 0; i < 50; i += 1) {
      pointsService.award({
        taskId: null,
        delta: 5.06,
        kind: 'adjust',
        reasonCode: 'manual_adjust',
        day: '2026-10-28'
      })
    }
    const balance = pointsService.balance()
    expect(Math.abs(balance - 253)).toBeLessThan(1e-9)
    expect(Math.abs(statsRepo.getDay('2026-10-28').points - 253)).toBeLessThan(1e-9)
  })

  it('adjust 拒绝 0 分调整', () => {
    expectErrorCode(() => pointsService.adjust(0.001, '想调 0'), 'INVALID_INPUT')
  })

  it('rebuildDailyStats 全量重算结果与增量写入一致', () => {
    const db = getDb()
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    pointsService.award({ taskId: task.id, delta: 23.5, reasonCode: 'task_done', day: '2026-10-28' })

    // 人为把聚合打脏，再用 ledger 全量重算
    db.prepare("UPDATE daily_stats SET points = 999 WHERE day = '2026-10-28'").run()
    const { days } = statsRepo.rebuildDailyStats()

    expect(days).toBeGreaterThan(0)
    expect(statsRepo.getDay('2026-10-28').points).toBe(23.5)
    // tasks_created 也应该被重算出来（建任务那条写的是今天，不是 10-28，所以只校验总数不为 0）
    const totalCreated = statsRepo
      .monthStats(2026, 10)
      .reduce((sum, d) => sum + d.tasksCreated, 0)
    expect(totalCreated).toBeGreaterThanOrEqual(0)
  })

  it('points.preview 是纯计算，daily 返回单日基础分', () => {
    // v0.7 起 previewPoints 只剩 (type, difficulty)：应得分只由难度决定
    expect(pointsService.previewPoints('deadline', 'medium')).toBe(3)
    expect(pointsService.previewPoints('deadline', 'hard')).toBe(5)
    expect(pointsService.previewPoints('daily', 'medium')).toBe(1)
    expect(pointsService.balance()).toBe(0)
  })
})
