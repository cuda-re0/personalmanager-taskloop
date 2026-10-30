import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Difficulty, Task } from '../../src/shared/types/domain'
import { fmtPoints } from '../../src/shared/format'
import { isoToLocalDay, nowIso, todayLocalDay } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as settingRepo from '../../src/main/db/repositories/settingRepo'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
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
 *
 * v0.38 起证据是**无条件**闸门（限时/活动一律要证据），所以默认挂一条文字证据；
 * 只有专门验证闸门的用例才传 `evidence: false`。
 */
function deadlineInProgress(options: {
  difficulty?: Difficulty
  /** 相对现在的截止时刻（小时，负数=已逾期）；null = 不设截止 */
  dueInHours?: number | null
  requiresEvidence?: boolean
  evidence?: boolean
}): Task {
  const { difficulty = 'medium', dueInHours = null, requiresEvidence = false, evidence = true } =
    options
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
  const reviewing = taskService.transitionTask(task.id, 'reviewing')
  if (!evidence) return reviewing
  return taskService.addEvidence(task.id, { kind: 'text', text: '已完成', addedAt: nowIso() })
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

  it('撤销后从 doing 直接再完成 → CONFLICT（状态机要求先走回 reviewing）', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    taskService.completeTask({ id: task.id, quality: 'met' })
    taskService.undoCompletion(task.id)

    // 挡住这次的是状态机（doing → done 不是合法边，01 §3），不是唯一索引：
    // **重做**必须先 transition 回 reviewing，那条路径由 tests/db/undoRedo.test.ts 锁
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

describe('task.complete · 证据闸门（01 §3，v0.38 起无条件）', () => {
  it('无证据 → EVIDENCE_REQUIRED，库无新流水、状态停在 reviewing', () => {
    const task = deadlineInProgress({ requiresEvidence: true, evidence: false })
    expectErrorCode(
      () => taskService.completeTask({ id: task.id, quality: 'met' }),
      'EVIDENCE_REQUIRED'
    )

    expect(ledgerRepo.countAll()).toBe(0)
    const after = taskService.requireTask(task.id)
    expect(after.status).toBe('reviewing')
    expect(after.completedAt).toBeNull()
    expect(after.pointsAwarded).toBeNull()
  })

  it('requiresEvidence=false 且无证据 → 同样 EVIDENCE_REQUIRED（锁 v0.38 修的漏分口子）', () => {
    const task = deadlineInProgress({ requiresEvidence: false, evidence: false })
    expectErrorCode(
      () => taskService.completeTask({ id: task.id, quality: 'met' }),
      'EVIDENCE_REQUIRED'
    )
    expect(ledgerRepo.countAll()).toBe(0)
    expect(taskService.requireTask(task.id).status).toBe('reviewing')
  })

  it('证据闸门的文案与 detail 保持 04 §1.1 的登记，只换了码名', () => {
    const task = deadlineInProgress({ requiresEvidence: true, evidence: false })
    let thrown: unknown
    try {
      taskService.completeTask({ id: task.id, quality: 'met' })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe('EVIDENCE_REQUIRED')
    expect((thrown as Error).message).toBe('证据不能为空')
    expect((thrown as { detail?: string }).detail).toBe('任务与入参都没有证据')
    // retryable: false（02 §1：缺资料，重试同一次请求不会变）
    expect((thrown as { retryable?: boolean }).retryable).toBe(false)
  })

  it('入参带证据 → 通过，并把证据落到任务上', () => {
    const task = deadlineInProgress({ requiresEvidence: true, evidence: false })
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

describe('task.complete · 活动 result（02 §3.2 v0.19）', () => {
  /** 待确认的活动任务（medium 应得分 20，event 的 quality 不进公式）；带证据过闸门 */
  function eventInReview(): Task {
    const task = taskService.createTask({ type: 'event', title: '期中考试', difficulty: 'medium' })
    taskService.transitionTask(task.id, 'doing')
    taskService.transitionTask(task.id, 'reviewing')
    return taskService.addEvidence(task.id, { kind: 'text', text: '成绩单', addedAt: nowIso() })
  }

  it("result: 'exceeded' → 20 × 1.2 = 24", () => {
    const task = eventInReview()
    const { entry } = taskService.completeTask({
      id: task.id,
      quality: 'met',
      result: 'exceeded'
    })
    expect(entry?.delta).toBe(24)
    expect(pointsService.balance()).toBe(24)
  })

  it("result: 'below' → 20 × 0.85 = 17", () => {
    const task = eventInReview()
    const { entry } = taskService.completeTask({ id: task.id, quality: 'met', result: 'below' })
    expect(entry?.delta).toBe(17)
  })

  it('不给 result → 按 ×1.0 结算（"没有结果信息"的合法值），quality 也不参与', () => {
    const task = eventInReview()
    // event 的 q 恒 1（02 §5）：给 partial 也是 20，不会 12
    const { entry } = taskService.completeTask({ id: task.id, quality: 'partial' })
    expect(entry?.delta).toBe(20)
  })

  it('deadline 传 result 一律忽略（契约是"忽略"，不是"拒绝"）', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    const { entry } = taskService.completeTask({
      id: task.id,
      quality: 'met',
      result: 'exceeded'
    })
    // 没有 due_at → 效率系数 1.0，result 不该再乘一次
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

  it('completed_at 距今超 24h → CONFLICT「超过 24 小时的完成记录不能撤销」，状态与余额都不动', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    taskService.completeTask({ id: task.id, quality: 'met' })

    // 把完成时刻拨到 25 小时前（窗口按 completed_at 判，不看 created_at）
    const old = new Date(Date.now() - 25 * 3600000).toISOString()
    taskRepo.updateColumns(task.id, { completed_at: old }, nowIso())

    let thrown: unknown
    try {
      taskService.undoCompletion(task.id)
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string }).code).toBe('CONFLICT')
    expect((thrown as Error).message).toBe('超过 24 小时的完成记录不能撤销')
    expect(taskService.requireTask(task.id).status).toBe('done')
    expect(pointsService.balance()).toBe(20)
    expect(ledgerRepo.countAll()).toBe(1)
  })

  it('23 小时前的完成记录仍可撤销（窗口是开区间，边界不过度收紧）', () => {
    const task = deadlineInProgress({ difficulty: 'medium' })
    taskService.completeTask({ id: task.id, quality: 'met' })

    const recent = new Date(Date.now() - 23 * 3600000).toISOString()
    taskRepo.updateColumns(task.id, { completed_at: recent }, nowIso())

    const undone = taskService.undoCompletion(task.id)
    expect(undone.task.status).toBe('doing')
    expect(pointsService.balance()).toBe(0)
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
