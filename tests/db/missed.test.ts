import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertTransition, isTransitionAllowed } from '../../src/main/db/stateMachine'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

/**
 * `missed`（v0.34，01 §3）：审核驳回且已过 due_at 时判失败。
 *
 * 这是终点状态：唯一入口是 `reviewing → missed`，唯一出口是归档。
 * 不计分、不写流水——`transition` 本身不碰 ledger，所以这里只需证明「走一遍之后
 * points_awarded 还是空、流水里没有这一行」。
 */
describe('missed 的状态边（§7.3）', () => {
  it('reviewing → missed 允许', () => {
    expect(isTransitionAllowed('deadline', 'reviewing', 'missed')).toBe(true)
    expect(isTransitionAllowed('event', 'reviewing', 'missed')).toBe(true)
  })

  it('todo / done → missed 拒绝（CONFLICT）', () => {
    expect(isTransitionAllowed('deadline', 'todo', 'missed')).toBe(false)
    expect(isTransitionAllowed('deadline', 'done', 'missed')).toBe(false)
    expectErrorCode(() => assertTransition('deadline', 'todo', 'missed'), 'CONFLICT')
    expectErrorCode(() => assertTransition('deadline', 'done', 'missed'), 'CONFLICT')
  })

  it('missed 只能往 archived 走', () => {
    expect(isTransitionAllowed('deadline', 'missed', 'archived')).toBe(true)
    expect(isTransitionAllowed('deadline', 'missed', 'doing')).toBe(false)
    expect(isTransitionAllowed('deadline', 'missed', 'reviewing')).toBe(false)
  })
})

describe('missed 不计分（§7.4）', () => {
  it('reviewing → missed 之后 points_awarded 仍为空、ledger 无新行', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交物理作业' })
    taskService.transitionTask(task.id, 'reviewing')

    const missed = taskService.transitionTask(task.id, 'missed')

    expect(missed.status).toBe('missed')
    expect(missed.pointsAwarded).toBeNull()
    expect(ledgerRepo.countAll()).toBe(0)
    expect(ledgerRepo.listByTask(task.id)).toHaveLength(0)
  })
})
