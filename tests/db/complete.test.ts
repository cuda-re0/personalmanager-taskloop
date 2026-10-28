import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Difficulty, Task } from '../../src/shared/types/domain'
import { fmtPoints } from '../../src/shared/format'
import { isoToLocalDay, todayLocalDay } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as settingRepo from '../../src/main/db/repositories/settingRepo'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
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
 * 建一个"待确认"的限时任务：状态机是 todo → doing → reviewing → done（01 §3），
 * `done` 只能从 `reviewing` 进入，所以完成前要先把这两条边都走过。
 */
function deadlineInProgress(options: {
  difficulty?: Difficulty
  /** 相对现在的截止时刻（小时，负数=已逾期）；null = 不设截止 */
  dueInHours?: number | null
  requiresEvidence?: boolean
}): Task {
  const { difficulty = 'medium', dueInHours = null, requiresEvidence = false } = options
  const dueAt =
    dueInHours === null ? null : new Date(Date.now() + dueInHours * 3600000).toISOString()
  const task = taskService.createTask({
    type: 'deadline',
    title: '交作业',
    difficulty,
    dueAt,
    requiresEvidence
  })
  taskService.transitionTask(task.id, 'doing')
  return taskService.transitionTask(task.id, 'reviewing')
}

describe('task.complete · 计分', () => {
  it('medium 完成 → 应得分 20、入账 20、余额 +20、明细一行', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    expect(task.pointsPlanned).toBe(20)

    const { task: done, entry } = taskService.completeTask({ id: task.id, quality: 'met' })

    expect(done.status).toBe('done')
    expect(done.completedAt).not.toBeNull()
    expect(done.pointsAwarded).toBe(20)
    expect(done.quality).toBe('met')
    expect(entry?.delta).toBe(20)
    expect(entry?.reasonCode).toBe('task_done')
    expect(entry?.occurrenceId).toBeNull()
    expect(pointsService.balance()).toBe(20)
    expect(ledgerRepo.countAll()).toBe(1)
    expect(statsRepo.getDay(todayLocalDay()).tasksDone).toBe(1)
    expect(statsRepo.getDay(todayLocalDay()).points).toBe(20)
  })

  it('easy 提前 30 小时 → 10 × 1.1 = 11，显示为 11 而不是 11.00', () => {
    const task = deadlineInProgress({ difficulty: 'easy', dueInHours: 30 })
    const { entry } = taskService.completeTask({ id: task.id, quality: 'met' })

    expect(entry?.delta).toBe(11)
    expect(fmtPoints(entry?.delta ?? 0)).toBe('11')
    expect(pointsService.balance()).toBe(11)
  })

  it('hard 提前 96 小时且超预期 → 35 × 1.2 × 1.15 = 48.3（保留小数）', () => {
    const task = deadlineInProgress({ difficulty: 'hard', dueInHours: 96 })
    const { entry } = taskService.completeTask({ id: task.id, quality: 'exceeded' })

    expect(entry?.delta).toBe(48.3)
    expect(fmtPoints(entry?.delta ?? 0)).toBe('48.3')
    expect(pointsService.balance()).toBe(48.3)
  })

  it('逾期 3 天完成 → 20 − 6 = 14（满 24 小时算一天）', () => {
    const task = deadlineInProgress({ difficulty: 'medium', dueInHours: -73 })
    const { entry } = taskService.completeTask({ id: task.id, quality: 'met' })

    expect(entry?.delta).toBe(14)
  })

  it('连续 4 个小数额任务，余额是 SUM(delta) 且没有浮点尾巴', () => {
    // 20 × 0.6 (partial) × 1.1 (提前 30h) = 13.2
    for (let i = 0; i < 4; i += 1) {
      const task = deadlineInProgress({ difficulty: 'medium', dueInHours: 30 })
      taskService.completeTask({ id: task.id, quality: 'partial' })
    }
    const balance = pointsService.balance()
    expect(Math.abs(balance - 52.8)).toBeLessThan(1e-9)
    expect(String(balance).length).toBeLessThanOrEqual('52.8'.length)
  })

  it('重复完成同一限时任务 → CONFLICT，库中仍只有一条流水', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    taskService.completeTask({ id: task.id, quality: 'met' })

    expectErrorCode(() => taskService.completeTask({ id: task.id, quality: 'met' }), 'CONFLICT')
    expect(ledgerRepo.countAll()).toBe(1)
    expect(pointsService.balance()).toBe(20)
    expect(taskService.requireTask(task.id).status).toBe('done')
  })

  it('撤销后再完成 → 被 uq_ledger_task_done 挡住（索引兜底，不是先查后插）', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    taskService.completeTask({ id: task.id, quality: 'met' })
    taskService.undoCompletion(task.id)

    // 状态已回到 doing，所以这次不会被状态校验拦下，是唯一索引在挡
    expectErrorCode(() => taskService.completeTask({ id: task.id, quality: 'met' }), 'CONFLICT')
    expect(pointsService.balance()).toBe(0)
  })

  it('todo 直接完成 → CONFLICT（状态机只允许 reviewing → done）', () => {
    const task = taskService.createTask({ type: 'deadline', title: '写周报' })
    expectErrorCode(() => taskService.completeTask({ id: task.id, quality: 'met' }), 'CONFLICT')
    expect(ledgerRepo.countAll()).toBe(0)
  })

  it('daily 任务不走 task.complete → CONFLICT「每日任务不进入审核/完成状态，请完成当天的打卡」', () => {
    const daily = taskService.createTask({ type: 'daily', title: '喝水' })
    let message = ''
    try {
      taskService.completeTask({ id: daily.id, quality: 'met' })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toBe('每日任务不进入审核/完成状态，请完成当天的打卡')
  })
})

describe('task.complete · 证据闸门（01 §3）', () => {
  it('requiresEvidence 且无证据 → CONFLICT，库无新流水、状态不变', () => {
    const task = deadlineInProgress({ requiresEvidence: true })
    expectErrorCode(() => taskService.completeTask({ id: task.id, quality: 'met' }), 'CONFLICT')

    expect(ledgerRepo.countAll()).toBe(0)
    const after = taskService.requireTask(task.id)
    expect(after.status).toBe('reviewing')
    expect(after.completedAt).toBeNull()
    expect(after.pointsAwarded).toBeNull()
  })

  it('requiresEvidence 但入参带证据 → 通过，并把证据落到任务上', () => {
    const task = deadlineInProgress({ requiresEvidence: true })
    const { task: done, entry } = taskService.completeTask({
      id: task.id,
      quality: 'met',
      evidence: [{ kind: 'text', text: '已提交 PDF', addedAt: new Date().toISOString() }]
    })

    expect(done.evidence).toHaveLength(1)
    expect(done.evidence[0].kind).toBe('text')
    expect(entry?.delta).toBe(20)
  })
})

describe('task.complete · noPoints（02 §3.2 的不计分出口）', () => {
  it('写 completed_at、points_awarded 为 NULL、entry 为 null、ledger 无行', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    const { task: done, entry } = taskService.completeTask({ id: task.id, noPoints: true })

    expect(done.status).toBe('done')
    expect(done.completedAt).not.toBeNull()
    expect(done.pointsAwarded).toBeNull()
    expect(done.quality).toBeNull()
    expect(entry).toBeNull()
    expect(ledgerRepo.countAll()).toBe(0)
    expect(pointsService.balance()).toBe(0)
    // 不计分也要计入当日完成数（02 §3.2）
    expect(statsRepo.getDay(todayLocalDay()).tasksDone).toBe(1)
  })

  it('不需要证据也能收尾（防死锁出口）', () => {
    const task = deadlineInProgress({ requiresEvidence: true })
    const { task: done, entry } = taskService.completeTask({ id: task.id, noPoints: true })
    expect(done.status).toBe('done')
    expect(entry).toBeNull()
  })

  it('重复不计分完成 → CONFLICT，tasks_done 不会加两次', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    taskService.completeTask({ id: task.id, noPoints: true })
    expectErrorCode(() => taskService.completeTask({ id: task.id, noPoints: true }), 'CONFLICT')
    expect(statsRepo.getDay(todayLocalDay()).tasksDone).toBe(1)
  })
})

describe('task.undoCompletion（done → doing，01 §3）', () => {
  it('余额回落、明细出现 -20、completed_at 清空、tasks_done 减回来', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    const { entry } = taskService.completeTask({ id: task.id, quality: 'met' })
    expect(entry?.delta).toBe(20)

    const undone = taskService.undoCompletion(task.id)

    expect(undone.task.status).toBe('doing')
    expect(undone.task.completedAt).toBeNull()
    expect(undone.task.pointsAwarded).toBeNull()
    expect(undone.entry?.delta).toBe(-20)
    expect(pointsService.balance()).toBe(0)
    expect(ledgerRepo.countAll()).toBe(2)
    expect(statsRepo.getDay(todayLocalDay()).tasksDone).toBe(0)
    expect(statsRepo.getDay(todayLocalDay()).points).toBe(0)
  })

  it('撤销 noPoints 完成 → 不写冲销流水（本来就没有入账）', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    taskService.completeTask({ id: task.id, noPoints: true })

    const undone = taskService.undoCompletion(task.id)
    expect(undone.entry).toBeNull()
    expect(undone.task.status).toBe('doing')
    expect(ledgerRepo.countAll()).toBe(0)
    expect(statsRepo.getDay(todayLocalDay()).tasksDone).toBe(0)
  })

  it('未完成的任务撤销是 no-op（同态不报错、不写库）', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    const undone = taskService.undoCompletion(task.id)
    expect(undone.entry).toBeNull()
    expect(undone.task.status).toBe('reviewing')
    expect(ledgerRepo.countAll()).toBe(0)
  })
})

describe('配置来源（02 §5.5：历史流水永不重算）', () => {
  it('改 points.difficultyBase 后历史流水不变，新任务按新表算', () => {
    const first = deadlineInProgress({ difficulty: 'medium' })
    const firstEntry = taskService.completeTask({ id: first.id, quality: 'met' }).entry
    expect(firstEntry?.delta).toBe(20)

    settingRepo.set('points.difficultyBase', {
      trivial: 5,
      easy: 10,
      medium: 30,
      hard: 35,
      epic: 50
    })

    // 历史流水不动
    expect(pointsService.listLedger()[0].delta).toBe(20)

    const second = deadlineInProgress({ difficulty: 'medium' })
    expect(second.pointsPlanned).toBe(30)
    const secondEntry = taskService.completeTask({ id: second.id, quality: 'met' }).entry
    expect(secondEntry?.delta).toBe(30)
    expect(pointsService.balance()).toBe(50)
  })
})

describe('daily_stats 与流水同日一致', () => {
  it('完成后的 day 字段是本地日，不是 UTC 日', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    const { task: done } = taskService.completeTask({ id: task.id, quality: 'met' })
    const day = isoToLocalDay(done.completedAt ?? '')
    expect(day).toBe(todayLocalDay())
    expect(statsRepo.getDay(day).points).toBe(20)
  })
})
