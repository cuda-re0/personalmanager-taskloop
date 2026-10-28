import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CH } from '@shared/channels'
import type { DomainEvent } from '@shared/types/events'
import type { Task, TaskDraft } from '@shared/types/domain'
import { setTransport } from '../../src/main/bus'
import * as messageService from '../../src/main/services/messageService'
import * as taskService from '../../src/main/services/taskService'
import { todayLocalDay } from '../../src/main/db/localDay'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
import { createHandlers, type IpcLike } from '../../src/main/ipc/registry'
import { g } from '../../src/main/ipc/guards'
import type { IpcResult } from '../../src/shared/types/ipc'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/**
 * task.promoteDraft（W5）。假 ipc + 假 transport + 内存库，模式同 handlers.test.ts。
 */

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

function makeFakeIpc(): IpcLike {
  return {
    handle() {
      /* 测试只走返回的 Map，不关心注册回调 */
    }
  }
}

/** 完整 TaskDraft 形状（02 §2）的造数器 */
function makeDraft(seed: Partial<TaskDraft> & Pick<TaskDraft, 'localId' | 'type' | 'title'>): TaskDraft {
  return {
    detailMd: '',
    dueHint: null,
    dailyTimeHint: null,
    activeToHint: null,
    reminderOffsets: seed.type === 'daily' ? [] : [-1440, -60],
    tags: [],
    steps: [],
    missingInfo: [],
    requiresEvidence: false,
    confidence: 0.8,
    pointsPlanned: 20,
    ...seed,
    difficulty: seed.difficulty ?? 'medium',
    estimateMin: seed.estimateMin ?? null
  }
}

function seedDraftMessage(drafts: TaskDraft[]): string {
  const message = messageService.appendMessage({
    role: 'assistant',
    kind: 'task_draft',
    meta: { kind: 'task_draft', drafts }
  })
  return message.id
}

describe('task.promoteDraft（W5）', () => {
  let wired: Map<string, (input: unknown) => unknown>
  let events: DomainEvent[]

  const call = (channel: string, input?: unknown): IpcResult<unknown> => {
    const fn = wired.get(channel)
    if (!fn) throw new Error(`通道未注册: ${channel}`)
    return fn(input) as IpcResult<unknown>
  }

  const callOk = (channel: string, input?: unknown): unknown => {
    const result = call(channel, input)
    if (!result.ok) {
      throw new Error(`预期 ${channel} ok:true，实际 ${result.error.code}: ${result.error.message}`)
    }
    return result.data
  }

  const eventsOf = (type: DomainEvent['type']): DomainEvent[] =>
    events.filter(e => e.type === type)

  beforeEach(() => {
    openMemoryDb()
    events = []
    setTransport(e => events.push(e))
    wired = createHandlers(makeFakeIpc())
  })

  afterEach(() => {
    setTransport(null)
    closeTestDb()
  })

  it('deadline 草稿：按 draft 落库（status todo、due_at、分值同源）、steps 写成子任务、meta 标 promoted', () => {
    const messageId = seedDraftMessage([
      makeDraft({
        localId: 'd-1',
        type: 'deadline',
        title: '交物理作业',
        detailMd: '导出 PDF',
        pointsPlanned: 33.5,
        dueHint: '2026-11-02T02:00:00.000Z',
        steps: [
          { localId: 's-1', title: '整理数据', estimateMin: 20, done: false },
          { localId: 's-2', title: '导出 PDF', estimateMin: 10, done: false }
        ],
        requiresEvidence: true,
        confidence: 0.9
      })
    ])

    const task = callOk(CH.task.promoteDraft, { messageId, localId: 'd-1' }) as Task

    expect(task.type).toBe('deadline')
    expect(task.status).toBe('todo')
    expect(task.title).toBe('交物理作业')
    // pointsPlanned 同源：写库值 = meta_json 里生成时算好的值（开工词红线 2）
    expect(task.pointsPlanned).toBe(33.5)
    expect(task.dueAt).toBe('2026-11-02T02:00:00.000Z')
    expect(task.requiresEvidence).toBe(true)
    expect(task.aiConfidence).toBe(0.9)
    expect(task.source).toBe('chat')

    // steps → 子任务
    const detail = taskService.getTaskWithSubtasks(task.id)
    expect(detail.subtasks.map(s => s.title)).toEqual(['整理数据', '导出 PDF'])
    expect(detail.subtasks.every(s => s.parentId === task.id && s.status === 'todo')).toBe(true)

    // meta_json 标 promoted + promotedTaskId；linked_task_id 指向任务
    const message = messageService.requireMessage(messageId)
    const marker = message.meta.kind === 'task_draft' ? message.meta.drafts[0] : null
    expect((marker as { promoted?: unknown }).promoted).toBe(true)
    expect((marker as { promotedTaskId?: unknown }).promotedTaskId).toBe(task.id)
    expect(message.linkedTaskId).toBe(task.id)
  })

  it('广播：父任务 + 子任务各一条 task.created、message.patch（meta）、daystats.changed', () => {
    const messageId = seedDraftMessage([
      makeDraft({
        localId: 'd-1',
        type: 'deadline',
        title: '交物理作业',
        steps: [{ localId: 's-1', title: '整理数据', estimateMin: 20, done: false }]
      })
    ])
    callOk(CH.task.promoteDraft, { messageId, localId: 'd-1' })

    const created = eventsOf('task.created')
    expect(created.length).toBe(2)
    const patched = eventsOf('message.patch')
    expect(patched.length).toBe(1)
    expect((patched[0] as { messageId: string }).messageId).toBe(messageId)
    expect(eventsOf('daystats.changed').length).toBe(1)
  })

  it('重复确认幂等：同一 draft 直调通道两次，只落一个任务，第二次返回原 Task', () => {
    const messageId = seedDraftMessage([makeDraft({ localId: 'd-1', type: 'deadline', title: '交物理作业' })])

    const first = callOk(CH.task.promoteDraft, { messageId, localId: 'd-1' }) as Task
    const countAfterFirst = taskRepo.countAll()
    const second = callOk(CH.task.promoteDraft, { messageId, localId: 'd-1' }) as Task

    expect(second.id).toBe(first.id)
    expect(taskRepo.countAll()).toBe(countAfterFirst)
  })

  it('daily 草稿：写 daily_time / repeat_rule / active_from，ensureRange 生成今天起 4 天 occurrence 并广播', () => {
    const messageId = seedDraftMessage([
      makeDraft({
        localId: 'd-1',
        type: 'daily',
        title: '背单词 30 个',
        pointsPlanned: 99, // daily 的传入值必须被忽略（02 §5.2b）
        dailyTimeHint: '21:00',
        reminderOffsets: [5] // daily 不使用偏移，createTask 会归一成 []
      })
    ])

    const task = callOk(CH.task.promoteDraft, { messageId, localId: 'd-1' }) as Task

    expect(task.type).toBe('daily')
    expect(task.dueAt).toBeNull()
    expect(task.dailyTime).toBe('21:00')
    expect(task.activeFrom).toBe(todayLocalDay())
    expect(task.reminderOffsets).toEqual([])
    // 分值唯一来源 cfg.dailyBase（默认 1），不是 draft 里的 99
    expect(task.pointsPlanned).toBe(1)

    // occurrence：今天 ~ +3 天各一条（DAILY 默认每天）
    const mine = occurrenceRepo.listByTask(task.id)
    expect(mine.length).toBe(4)
    expect(mine.some(o => o.day === todayLocalDay())).toBe(true)

    // handler 层广播 occurrence.created（ensureRange 前后差集）
    const created = eventsOf('occurrence.created').flatMap(
      e => (e as { occurrences: { taskId: string }[] }).occurrences
    )
    expect(created.filter(o => o.taskId === task.id).length).toBeGreaterThanOrEqual(4)
  })

  it('patch.difficulty：同事务按 cfg 重算 points_planned；非法 type×difficulty 只拒 INVALID_INPUT', () => {
    const messageId = seedDraftMessage([makeDraft({ localId: 'd-1', type: 'deadline', title: '交物理作业' })])

    const task = callOk(CH.task.promoteDraft, {
      messageId,
      localId: 'd-1',
      patch: { difficulty: 'hard' }
    }) as Task
    // draft.pointsPlanned=20（medium），patch 改 hard 后按当前配置重算 = 35
    expect(task.difficulty).toBe('hard')
    expect(task.pointsPlanned).toBe(35)

    // trivial 对 deadline 非法：主进程只拒绝、不归位（02 §5.2b）
    const messageId2 = seedDraftMessage([makeDraft({ localId: 'd-2', type: 'deadline', title: '另一件事' })])
    const result = call(CH.task.promoteDraft, { messageId: messageId2, localId: 'd-2', patch: { difficulty: 'trivial' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe('该任务类型不支持所选难度')
  })

  it('guard 拒 type：patch 里的 type 被 zod 剥掉，不落库、不报错（落库后不可改类型，02 §3.2）', () => {
    const parsed = g.promoteDraft.parse({
      messageId: 'm-1',
      localId: 'd-1',
      patch: { title: 'x', type: 'daily' }
    })
    expect((parsed.patch as Record<string, unknown>).type).toBeUndefined()

    const messageId = seedDraftMessage([makeDraft({ localId: 'd-1', type: 'deadline', title: '交物理作业' })])
    const task = callOk(CH.task.promoteDraft, {
      messageId,
      localId: 'd-1',
      patch: { type: 'daily' }
    }) as Task
    expect(task.type).toBe('deadline')
  })

  it('dueHint 形状校验：无年份形态不交给 new Date，落 NULL（V8 会把 10-30 18:00 解析成 2001 年）', () => {
    const messageId = seedDraftMessage([
      makeDraft({ localId: 'd-1', type: 'deadline', title: '交物理作业', dueHint: '10-30 18:00' })
    ])
    const task = callOk(CH.task.promoteDraft, { messageId, localId: 'd-1' }) as Task
    expect(task.dueAt).toBeNull()
  })

  it('错误：消息不存在 NOT_FOUND；localId 对不上 / meta 不是草稿 INVALID_INPUT', () => {
    const badId = call(CH.task.promoteDraft, { messageId: 'no-such', localId: 'd-1' })
    expect(badId.ok).toBe(false)
    if (!badId.ok) expect(badId.error.code).toBe('NOT_FOUND')

    const messageId = seedDraftMessage([makeDraft({ localId: 'd-1', type: 'daily', title: '喝水' })])
    const missing = call(CH.task.promoteDraft, { messageId, localId: 'd-other' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('INVALID_INPUT')

    const textId = messageService.appendMessage({ role: 'user', kind: 'text', contentMd: 'hi' }).id
    const wrongKind = call(CH.task.promoteDraft, { messageId: textId, localId: 'd-1' })
    expect(wrongKind.ok).toBe(false)
    if (!wrongKind.ok) expect(wrongKind.error.code).toBe('INVALID_INPUT')
  })

  it('红线：transition({to:"done"}) 恒 409「完成任务请走完成流程」', () => {
    const task = taskService.createTask({ type: 'deadline', title: '写周报' })
    const result = call(CH.task.transition, { id: task.id, to: 'done' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT')
      expect(result.error.message).toBe('完成任务请走完成流程')
    }
    expect(taskService.getTask(task.id)?.status).toBe('todo')
  })
})
