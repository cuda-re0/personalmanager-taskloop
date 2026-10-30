import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTransitionAllowed } from '../../src/main/db/stateMachine'
import { nowIso } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
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
 * `todo → reviewing`（v0.25，01 §3）。
 *
 * 界面没有「开始」按钮，新建任务默认就是 `todo`；不允许这条边等于「新建的限时/活动任务
 * 永远完不成」。这条边**不改 `started_at`**：没开始过就是没开始过。
 */
describe('todo → reviewing（v0.25 合法边）', () => {
  it('限时任务：允许，且不写 started_at', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    expect(task.status).toBe('todo')
    expect(task.startedAt).toBeNull()

    const reviewing = taskService.transitionTask(task.id, 'reviewing')

    expect(reviewing.status).toBe('reviewing')
    // 关键断言：直达 reviewing 不许偷偷写 started_at（那会凭空造出"我什么时候开始的"）
    expect(reviewing.startedAt).toBeNull()
    expect(isTransitionAllowed('deadline', 'todo', 'reviewing')).toBe(true)
  })

  it('活动任务：允许，且不写 started_at', () => {
    const task = taskService.createTask({ type: 'event', title: '期中考试' })

    const reviewing = taskService.transitionTask(task.id, 'reviewing')

    expect(reviewing.status).toBe('reviewing')
    expect(reviewing.startedAt).toBeNull()
    expect(isTransitionAllowed('event', 'todo', 'reviewing')).toBe(true)
  })

  it('每日任务：仍是 CONFLICT「每日任务不进入审核/完成状态，请完成当天的打卡」', () => {
    const daily = taskService.createTask({ type: 'daily', title: '喝水' })

    expect(isTransitionAllowed('daily', 'todo', 'reviewing')).toBe(false)
    expectErrorCode(() => taskService.transitionTask(daily.id, 'reviewing'), 'CONFLICT')

    let message = ''
    try {
      taskService.transitionTask(daily.id, 'reviewing')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toBe('每日任务不进入审核/完成状态，请完成当天的打卡')
    expect(taskService.requireTask(daily.id).status).toBe('todo')
  })

  it('端到端：新建 todo 限时任务 → reviewing → 完成 → done 并入账', () => {
    const task = taskService.createTask({ type: 'deadline', title: '写周报' })
    taskService.transitionTask(task.id, 'reviewing')
    // v0.38 起限时/活动一律要证据，没证据完成会撞 EVIDENCE_REQUIRED
    taskService.addEvidence(task.id, { kind: 'text', text: '周报链接', addedAt: nowIso() })

    const { task: done, entry } = taskService.completeTask({ id: task.id, quality: 'met' })

    expect(done.status).toBe('done')
    expect(done.pointsAwarded).toBe(20)
    expect(entry?.reasonCode).toBe('task_done')
    // 任务完成流水必须挂任务、不挂 occurrence（01 §3）
    expect(entry?.occurrenceId).toBeNull()
    expect(ledgerRepo.countAll()).toBe(1)
    expect(ledgerRepo.listByTask(task.id)).toHaveLength(1)
    expect(pointsService.balance()).toBe(20)
  })
})

/**
 * v0.38：新增 `pending_review`（待提交）。点完成先落到这里，用户交材料后才进 reviewing。
 *
 * 这条状态的意义是把「等自己交材料」和「等 AI 看材料」分开：10 分钟超时扫描只看
 * `pending_review`，`reviewing` 一条都不动（否则正在审核的任务会被打回原形）。
 */
describe('pending_review（v0.38 待提交）', () => {
  it('todo → pending_review、doing → pending_review 允许', () => {
    expect(isTransitionAllowed('deadline', 'todo', 'pending_review')).toBe(true)
    expect(isTransitionAllowed('deadline', 'doing', 'pending_review')).toBe(true)

    const fromTodo = taskService.createTask({ type: 'deadline', title: '写周报' })
    expect(taskService.transitionTask(fromTodo.id, 'pending_review').status).toBe('pending_review')

    const fromDoing = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.transitionTask(fromDoing.id, 'doing')
    expect(taskService.transitionTask(fromDoing.id, 'pending_review').status).toBe('pending_review')
  })

  it('pending_review → reviewing / doing 允许（提交与取消/超时）', () => {
    expect(isTransitionAllowed('deadline', 'pending_review', 'reviewing')).toBe(true)
    expect(isTransitionAllowed('deadline', 'pending_review', 'doing')).toBe(true)

    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.transitionTask(task.id, 'pending_review')
    expect(taskService.transitionTask(task.id, 'reviewing').status).toBe('reviewing')
    expect(taskService.transitionTask(task.id, 'doing').status).toBe('doing')
  })

  it('pending_review → done 拒绝（完成必须过审，01 §3）', () => {
    expect(isTransitionAllowed('deadline', 'pending_review', 'done')).toBe(false)
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.transitionTask(task.id, 'pending_review')
    expectErrorCode(() => taskService.transitionTask(task.id, 'done'), 'CONFLICT')
  })

  it('每日任务不能进 pending_review（与 reviewing / done 同一条禁令）', () => {
    expect(isTransitionAllowed('daily', 'todo', 'pending_review')).toBe(false)
    const daily = taskService.createTask({ type: 'daily', title: '喝水' })
    expectErrorCode(() => taskService.transitionTask(daily.id, 'pending_review'), 'CONFLICT')
    expect(taskService.requireTask(daily.id).status).toBe('todo')
  })
})
