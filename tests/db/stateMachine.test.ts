import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTransitionAllowed } from '../../src/main/db/stateMachine'
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
