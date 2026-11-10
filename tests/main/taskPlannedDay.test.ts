import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from '../db/helpers'

/**
 * 计划日（91 §2.6 / §2.10）的落库口径：`planned_day` 存取一致、非法值在业务层被拒。
 * 用内存库，每个用例一份干净库。
 */
beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('tasks.planned_day（v0.93）', () => {
  it('带 plannedDay 建任务 → 回读一致', () => {
    const created = taskService.createTask({
      type: 'deadline',
      title: '交实验报告',
      plannedDay: '2026-12-01',
      dueAt: '2026-12-31T14:00:00.000Z'
    })
    expect(created.plannedDay).toBe('2026-12-01')
    expect(taskService.requireTask(created.id).plannedDay).toBe('2026-12-01')
  })

  it('不给 plannedDay → 回读为 null（老行为不变）', () => {
    const created = taskService.createTask({ type: 'deadline', title: '随手记一条' })
    expect(created.plannedDay).toBeNull()
    expect(taskService.requireTask(created.id).plannedDay).toBeNull()
  })

  it('非法日期（2026-02-30）→ INVALID_INPUT', () => {
    expectErrorCode(
      () =>
        taskService.createTask({
          type: 'deadline',
          title: '日期是编的',
          plannedDay: '2026-02-30'
        }),
      'INVALID_INPUT'
    )
  })

  it('daily 带 plannedDay → INVALID_INPUT（每日任务不需要计划日）', () => {
    expectErrorCode(
      () =>
        taskService.createTask({
          type: 'daily',
          title: '背单词',
          plannedDay: '2026-12-01'
        }),
      'INVALID_INPUT'
    )
  })

  it('update 带 plannedDay 能改；带 null 能清掉', () => {
    const created = taskService.createTask({
      type: 'deadline',
      title: '写周报',
      plannedDay: '2026-12-01'
    })
    const moved = taskService.updateTask(created.id, { plannedDay: '2026-12-03' })
    expect(moved.plannedDay).toBe('2026-12-03')

    const cleared = taskService.updateTask(created.id, { plannedDay: null })
    expect(cleared.plannedDay).toBeNull()
  })

  it('update 在 daily 上写 plannedDay → INVALID_INPUT', () => {
    const created = taskService.createTask({ type: 'daily', title: '跑步' })
    expectErrorCode(
      () => taskService.updateTask(created.id, { plannedDay: '2026-12-01' }),
      'INVALID_INPUT'
    )
  })
})
