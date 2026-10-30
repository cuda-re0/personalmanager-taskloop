import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CH } from '@shared/channels'
import type { IpcResult } from '@shared/types/ipc'
import type { DomainEvent } from '@shared/types/events'
import { setTransport } from '../../src/main/bus'
import { nowIso, todayLocalDay } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
import * as pointsService from '../../src/main/services/pointsService'
import * as taskService from '../../src/main/services/taskService'
import { createHandlers, type IpcLike } from '../../src/main/ipc/registry'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/** 与 handlers.test.ts / w6Channels.test.ts 同一套假运行时 */
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

function makeFakeIpc(): IpcLike {
  return { handle() {} }
}

/**
 * `task.undo`（02 §3.2，v0.19）。锁四件事：
 * 1) 撤销后余额回落、明细出等额负流水（不删行）；
 * 2) 撤销后能重做（唯一索引的谓词带 `reversed_at IS NULL`）；
 * 3) 24h 窗口报 CONFLICT，且状态/余额不动；
 * 4) 不是 done 的任务是同态 no-op：零写入、零广播。
 */
describe('task.undo 通道', () => {
  let wired: Map<string, (input: unknown) => unknown>
  let events: DomainEvent[]

  const call = (channel: string, input?: unknown): IpcResult<unknown> => {
    const fn = wired.get(channel)
    if (!fn) throw new Error(`通道未注册: ${channel}`)
    return fn(input) as IpcResult<unknown>
  }

  const callOk = <T>(channel: string, input?: unknown): T => {
    const result = call(channel, input)
    if (!result.ok) {
      throw new Error(`预期 ${channel} ok:true，实际 ${result.error.code}: ${result.error.message}`)
    }
    return result.data as T
  }

  const eventsOf = (type: DomainEvent['type']): DomainEvent[] => events.filter(e => e.type === type)

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

  /** 待确认的限时任务（done 只能从 reviewing 进入，01 §3）；v0.38 起完成必须带证据 */
  function reviewing(): string {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.transitionTask(task.id, 'doing')
    taskService.transitionTask(task.id, 'reviewing')
    return taskService.addEvidence(task.id, { kind: 'text', text: '已交作业', addedAt: nowIso() }).id
  }

  it('撤销 → 余额回落、明细出 -20、状态回 doing，广播 task.updated + points.changed + daystats', () => {
    const id = reviewing()
    callOk(CH.task.complete, { id, quality: 'met' })
    events = []

    const data = callOk<{ task: { status: string }; entry: { delta: number } | null }>(
      CH.task.undo,
      { id }
    )

    expect(data.task.status).toBe('doing')
    expect(data.entry?.delta).toBe(-20)
    expect(pointsService.balance()).toBe(0)
    // 原发分行 + 冲销行：撤销不删流水
    expect(ledgerRepo.countAll()).toBe(2)
    const original = ledgerRepo.listByTask(id).find(e => e.reasonCode === 'task_done')
    expect(original?.reversedAt).not.toBeNull()

    const updated = eventsOf('task.updated')[0] as { changed: string[] }
    expect(updated.changed).toContain('status')
    const points = eventsOf('points.changed')[0] as { balance: number; entry: { delta: number } }
    expect(points.balance).toBe(0)
    expect(points.entry.delta).toBe(-20)
    // 原完成日就是今天：只推今天这一份聚合
    const daystats = eventsOf('daystats.changed')
    expect(daystats).toHaveLength(1)
    expect((daystats[0] as { day: { tasksDone: number } }).day.tasksDone).toBe(0)
    expect(statsRepo.getDay(todayLocalDay()).points).toBe(0)
  })

  it('撤销后重做（先回 reviewing）能再次入账，余额与明细都是 +20', () => {
    const id = reviewing()
    callOk(CH.task.complete, { id, quality: 'met' })
    callOk(CH.task.undo, { id })

    // doing → reviewing 是合法边；done → done 才是 CONFLICT（01 §3）
    callOk(CH.task.transition, { id, to: 'reviewing' })
    const again = callOk<{ task: { status: string }; entry: { delta: number } }>(CH.task.complete, {
      id,
      quality: 'met'
    })

    expect(again.task.status).toBe('done')
    expect(again.entry.delta).toBe(20)
    expect(pointsService.balance()).toBe(20)
    // +20 / -20 / +20 三条，有效发分只有最后一条
    expect(ledgerRepo.countAll()).toBe(3)
    const effective = ledgerRepo
      .listByTask(id)
      .filter(e => e.reasonCode === 'task_done' && e.reversedAt === null)
    expect(effective).toHaveLength(1)
  })

  it('completed_at 超 24h → CONFLICT「超过 24 小时的完成记录不能撤销」，零广播', () => {
    const id = reviewing()
    callOk(CH.task.complete, { id, quality: 'met' })
    taskRepo.updateColumns(
      id,
      { completed_at: new Date(Date.now() - 25 * 3600000).toISOString() },
      nowIso()
    )
    events = []

    const result = call(CH.task.undo, { id })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('CONFLICT')
      expect(result.error.message).toBe('超过 24 小时的完成记录不能撤销')
    }
    expect(pointsService.balance()).toBe(20)
    expect(taskService.requireTask(id).status).toBe('done')
    expect(events).toEqual([])
  })

  it('不是 done 的任务撤销 → 同态 no-op：不报错、不写库、不广播', () => {
    const id = reviewing()

    const data = callOk<{ task: { status: string }; entry: unknown }>(CH.task.undo, { id })

    expect(data.task.status).toBe('reviewing')
    expect(data.entry).toBeNull()
    expect(ledgerRepo.countAll()).toBe(0)
    expect(events).toEqual([])
  })

  it('入参非法 / 任务不存在 → INVALID_INPUT 与 NOT_FOUND，都不广播', () => {
    const bad = call(CH.task.undo, { id: 1 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.error.code).toBe('INVALID_INPUT')
      expect(bad.error.message).toBe('请求参数格式不正确')
    }

    const missing = call(CH.task.undo, { id: 'nope' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.error.code).toBe('NOT_FOUND')
      expect(missing.error.message).toBe('任务不存在')
    }
    expect(events).toEqual([])
  })
})
