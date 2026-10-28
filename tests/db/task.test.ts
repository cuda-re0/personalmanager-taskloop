import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Evidence } from '../../src/shared/types/domain'
import { getDb } from '../../src/main/db/connection'
import { newId } from '../../src/main/db/ids'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
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

describe('tasks 建/查/改', () => {
  it('建任务 → 查任务，字段全等（含 type / repeatRule / reminderOffsets / requiresEvidence）', () => {
    const evidence: Evidence = { kind: 'text', text: '报告已提交', addedAt: NOW }
    const created = taskService.createTask({
      type: 'deadline',
      title: '交作业',
      detailMd: '写完后发给老师',
      priority: 2,
      difficulty: 'hard',
      estimateMin: 120,
      dueAt: '2026-10-30T14:00:00.000Z',
      reminderOffsets: [-30, -10],
      reminderChannels: ['inapp', 'mail'],
      tags: ['作业', '重要'],
      pointsPlanned: 45.5,
      requiresEvidence: true,
      evidence: [evidence],
      source: 'manual',
      aiConfidence: 0.62
    })

    const fetched = taskService.requireTask(created.id)
    expect(fetched).toEqual(created)
    expect(fetched.type).toBe('deadline')
    expect(fetched.status).toBe('todo')
    expect(fetched.title).toBe('交作业')
    expect(fetched.detailMd).toBe('写完后发给老师')
    expect(fetched.priority).toBe(2)
    expect(fetched.difficulty).toBe('hard')
    expect(fetched.estimateMin).toBe(120)
    expect(fetched.dueAt).toBe('2026-10-30T14:00:00.000Z')
    expect(fetched.repeatRule).toBeNull()
    expect(fetched.reminderOffsets).toEqual([-30, -10])
    expect(fetched.reminderChannels).toEqual(['inapp', 'mail'])
    expect(fetched.tags).toEqual(['作业', '重要'])
    expect(fetched.pointsPlanned).toBe(45.5)
    expect(fetched.requiresEvidence).toBe(true)
    expect(fetched.evidence).toEqual([evidence])
    expect(fetched.source).toBe('manual')
    expect(fetched.aiConfidence).toBe(0.62)
    expect(fetched.parentId).toBeNull()
    expect(fetched.pointsAwarded).toBeNull()
    expect(fetched.quality).toBeNull()
    expect(fetched.startedAt).toBeNull()
    expect(fetched.completedAt).toBeNull()
    expect(fetched.archivedAt).toBeNull()
  })

  it('daily 任务：repeatRule / activeFrom / activeTo / dailyTime 落库，dueAt 归一为 null 且不吃偏移', () => {
    const task = taskService.createTask({
      type: 'daily',
      title: '跑步',
      dailyTime: '21:00',
      repeatRule: 'WEEKLY:1,3,5',
      activeFrom: '2026-10-01',
      activeTo: '2026-12-31',
      dueAt: '2026-10-28T13:00:00.000Z',
      reminderOffsets: [-60],
      pointsPlanned: 1
    })

    expect(task.dueAt).toBeNull()
    expect(task.reminderOffsets).toEqual([])
    expect(task.repeatRule).toBe('WEEKLY:1,3,5')
    expect(task.dailyTime).toBe('21:00')
    expect(task.activeFrom).toBe('2026-10-01')
    expect(task.activeTo).toBe('2026-12-31')
    expect(task.pointsPlanned).toBe(1)
    // REAL 字段即便值是整数形态也不能变成 INTEGER / 字符串
    expect(typeof task.pointsPlanned).toBe('number')
  })

  it('estimateMin 的 null 不会被映射成 undefined（也不缺字段）', () => {
    const task = taskService.createTask({ type: 'deadline', title: '缴费', estimateMin: null })
    expect(task.estimateMin).toBeNull()
    expect('estimateMin' in task).toBe(true)
    expect(task.difficulty).toBe('easy')
  })

  it('默认提醒偏移按类型补齐（deadline / event）', () => {
    const deadline = taskService.createTask({ type: 'deadline', title: '交报告' })
    expect(deadline.reminderOffsets).toEqual([-1440, -60])

    const event = taskService.createTask({ type: 'event', title: '面试' })
    expect(event.reminderOffsets).toEqual([-10080, -4320, -1440])
  })

  it('PATCH 语义：只改传进来的字段，传 null 能清空', () => {
    const task = taskService.createTask({
      type: 'deadline',
      title: '交作业',
      estimateMin: 90,
      dueAt: '2026-10-30T14:00:00.000Z'
    })

    const patched = taskService.updateTask(task.id, { estimateMin: null, title: '交作业（改）' })
    expect(patched.estimateMin).toBeNull()
    expect(patched.title).toBe('交作业（改）')
    expect(patched.dueAt).toBe('2026-10-30T14:00:00.000Z')
    expect(patched.updatedAt >= task.updatedAt).toBe(true)
  })

  it('标题校验：空标题与超 40 字被拒', () => {
    expectErrorCode(() => taskService.createTask({ type: 'deadline', title: '   ' }), 'INVALID_INPUT')
    expectErrorCode(
      () => taskService.createTask({ type: 'deadline', title: 'a'.repeat(41) }),
      'INVALID_INPUT'
    )
  })

  it('列表默认只给顶层任务，includeSubtasks 才带子步骤', () => {
    const parent = taskService.createTask({ type: 'deadline', title: '父任务' })
    taskService.createTask({ type: 'deadline', title: '子步骤', parentId: parent.id })

    const topOnly = taskService.listTasks({ status: ['todo'] })
    expect(topOnly.map(t => t.title)).toEqual(['父任务'])

    const all = taskService.listTasks({ status: ['todo'], includeSubtasks: true })
    expect(all).toHaveLength(2)
    expect(taskService.getTaskWithSubtasks(parent.id).subtasks).toHaveLength(1)
  })

  it('evidence 追加不覆盖原有证据', () => {
    const task = taskService.createTask({ type: 'deadline', title: '写论文', requiresEvidence: true })
    const first: Evidence = { kind: 'text', text: '初稿', addedAt: NOW }
    const second: Evidence = { kind: 'image', attachmentId: 'att_1', addedAt: NOW }

    taskService.addEvidence(task.id, first)
    const after = taskService.addEvidence(task.id, second)
    expect(after.evidence).toHaveLength(2)
    expect(after.evidence[1]).toEqual(second)
    expect(taskService.setRequiresEvidence(task.id, false).requiresEvidence).toBe(false)
  })
})

describe('tasks 状态机', () => {
  it('todo → done 直跳被拒（CONFLICT）', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    expectErrorCode(() => taskService.transitionTask(task.id, 'done'), 'CONFLICT')
    expect(taskService.requireTask(task.id).status).toBe('todo')
  })

  it('todo → doing → reviewing → done 通过', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    const doing = taskService.transitionTask(task.id, 'doing')
    expect(doing.status).toBe('doing')
    expect(doing.startedAt).not.toBeNull()

    const reviewing = taskService.transitionTask(task.id, 'reviewing')
    expect(reviewing.status).toBe('reviewing')

    const done = taskService.transitionTask(task.id, 'done')
    expect(done.status).toBe('done')
    expect(done.completedAt).not.toBeNull()
  })

  it('reviewing 被驳回回 doing 通过；done 可以在之后撤销回 doing', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.transitionTask(task.id, 'doing')
    taskService.transitionTask(task.id, 'reviewing')
    expect(taskService.transitionTask(task.id, 'doing').status).toBe('doing')

    taskService.transitionTask(task.id, 'reviewing')
    taskService.transitionTask(task.id, 'done')
    expect(taskService.transitionTask(task.id, 'doing').status).toBe('doing')
  })

  it('daily 任务走 reviewing / done 被拒（走 occurrence，不走任务状态机）', () => {
    const daily = taskService.createTask({ type: 'daily', title: '背单词' })
    expectErrorCode(() => taskService.transitionTask(daily.id, 'reviewing'), 'CONFLICT')
    expectErrorCode(() => taskService.transitionTask(daily.id, 'done'), 'CONFLICT')
    // 但 daily 可以 doing / archived
    expect(taskService.transitionTask(daily.id, 'doing').status).toBe('doing')
    expect(taskService.transitionTask(daily.id, 'archived').status).toBe('archived')
  })

  it('同态流转是幂等 no-op，不报错也不改 updatedAt', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    const again = taskService.transitionTask(task.id, 'todo')
    expect(again.updatedAt).toBe(task.updatedAt)
  })

  it('archived 是终态，再流转被拒', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.transitionTask(task.id, 'archived')
    expectErrorCode(() => taskService.transitionTask(task.id, 'doing'), 'CONFLICT')
  })

  it('remove 是软删 → discarded', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.removeTask(task.id)
    expect(taskService.requireTask(task.id).status).toBe('discarded')
  })
})

describe('外键级联', () => {
  it('删父任务 → 子任务级联删、occurrence 级联删、流水 task_id 置 NULL（流水不删）', () => {
    const db = getDb()
    const parent = taskService.createTask({ type: 'daily', title: '父：每日复盘' })
    const child = taskService.createTask({ type: 'deadline', title: '子：写总结', parentId: parent.id })

    // 父任务的一条 occurrence + 一条指向父任务的流水
    occurrenceRepo.insertIfAbsent(parent.id, '2026-10-28', NOW)
    const occ = occurrenceRepo.listByTask(parent.id)[0]
    expect(occ).toBeDefined()
    const entry = pointsService.award({
      taskId: parent.id,
      occurrenceId: occ.id,
      delta: 1,
      reasonCode: 'task_done',
      day: '2026-10-28'
    })

    taskRepo.hardDelete(parent.id)

    expect(taskService.getTask(parent.id)).toBeNull()
    expect(taskService.getTask(child.id)).toBeNull()
    expect(occurrenceRepo.listByTask(parent.id)).toHaveLength(0)

    // 流水还在，但 task_id / occurrence_id 被置 NULL
    const ledger = db
      .prepare('SELECT task_id, occurrence_id, delta FROM point_ledger WHERE id = ?')
      .get(entry.id) as { task_id: string | null; occurrence_id: string | null; delta: number }
    expect(ledger.task_id).toBeNull()
    expect(ledger.occurrence_id).toBeNull()
    expect(ledger.delta).toBe(1)
    // 余额不受删除影响
    expect(pointsService.balance()).toBe(1)
  })

  it('新 id 是 12 位字符串（nanoid(12) 规格）', () => {
    const id = newId()
    expect(id).toHaveLength(12)
    expect(typeof id).toBe('string')
  })
})
