import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CH } from '@shared/channels'
import type { IpcResult } from '@shared/types/ipc'
import type { DomainEvent } from '@shared/types/events'
import { setTransport } from '../../src/main/bus'
import { addDays, todayLocalDay } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import * as pointsService from '../../src/main/services/pointsService'
import * as taskService from '../../src/main/services/taskService'
import { createHandlers, type IpcLike } from '../../src/main/ipc/registry'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/** 与 handlers.test.ts 同一套假运行时：没有真实 electron，ipc 用注入实现 */
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

function makeFakeIpc(): IpcLike {
  return { handle() {} }
}

describe('W6 四条通道（假 ipc + 假 transport + 内存库）', () => {
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

  /** 待确认的限时任务（done 只能从 reviewing 进入，01 §3） */
  function deadline(): string {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    taskService.transitionTask(task.id, 'doing')
    return taskService.transitionTask(task.id, 'reviewing').id
  }

  function dailyToday(): { taskId: string; occurrenceId: string } {
    const task = taskService.createTask({ type: 'daily', title: '喝水', source: 'manual' })
    // createTask 不补 occurrence（只有 occurrence.today / listByRange 与 promoteDraft 会补），
    // 这里直接把今天这一行铺出来
    occurrenceRepo.insertIfAbsent(task.id, todayLocalDay(), new Date().toISOString())
    const [occ] = occurrenceRepo.listByTask(task.id)
    return { taskId: task.id, occurrenceId: occ.id }
  }

  it('task.complete 计分 → task.updated + points.changed(带 entry) + daystats.changed', () => {
    const id = deadline()
    events = []

    const data = callOk<{ task: { status: string }; entry: { delta: number } | null }>(
      CH.task.complete,
      { id, quality: 'met' }
    )

    expect(data.task.status).toBe('done')
    expect(data.entry?.delta).toBe(20)
    expect(eventsOf('task.updated').length).toBe(1)
    const points = eventsOf('points.changed')[0] as { balance: number; entry: { delta: number } }
    expect(points.balance).toBe(20)
    expect(points.entry.delta).toBe(20)
    expect((eventsOf('daystats.changed')[0] as { day: { tasksDone: number } }).day.tasksDone).toBe(1)
  })

  it('task.complete noPoints → entry 为 null、ledger 无行，仍广播 points.changed 与 daystats', () => {
    const id = deadline()
    events = []

    const data = callOk<{ entry: unknown }>(CH.task.complete, { id, noPoints: true })

    expect(data.entry).toBeNull()
    expect(ledgerRepo.countAll()).toBe(0)
    const points = eventsOf('points.changed')[0] as { balance: number; entry: unknown }
    expect(points.balance).toBe(0)
    expect(points.entry).toBeNull()
    expect(eventsOf('daystats.changed').length).toBe(1)
  })

  it('task.complete 同时给 quality 与 noPoints:true → INVALID_INPUT，不写库不广播', () => {
    const id = deadline()
    events = []

    const result = call(CH.task.complete, { id, quality: 'met', noPoints: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT')
      expect(result.error.message).toBe('请求参数格式不正确')
    }
    expect(ledgerRepo.countAll()).toBe(0)
    expect(events).toEqual([])
  })

  it('task.complete 重复完成 → CONFLICT（唯一索引兜底），库中仍只有一条流水', () => {
    const id = deadline()
    callOk(CH.task.complete, { id, quality: 'met' })
    events = []

    const result = call(CH.task.complete, { id, quality: 'met' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CONFLICT')
    expect(ledgerRepo.countAll()).toBe(1)
    expect(events).toEqual([])
  })

  it('occurrence.complete → occurrence.updated + task.updated(streak) + points.changed + daystats.changed', () => {
    const { occurrenceId } = dailyToday()
    events = []

    const data = callOk<{
      occurrence: { status: string }
      entry: { delta: number }
      streakAfter: number
    }>(CH.occurrence.complete, { id: occurrenceId })

    expect(data.occurrence.status).toBe('done')
    expect(data.entry.delta).toBe(1)
    expect(data.streakAfter).toBe(1)
    expect(eventsOf('occurrence.updated').length).toBe(1)

    const taskUpdated = eventsOf('task.updated')[0] as { changed: string[] }
    expect(taskUpdated.changed).toContain('streakCurrent')
    expect((eventsOf('daystats.changed')[0] as { day: { occurrencesDone: number } }).day.occurrencesDone).toBe(1)
  })

  it('occurrence.undo → 余额回落、返回 balanceAfter、occurrence 退回 pending', () => {
    const { occurrenceId } = dailyToday()
    callOk(CH.occurrence.complete, { id: occurrenceId })
    events = []

    const data = callOk<{ occurrence: { status: string }; balanceAfter: number }>(
      CH.occurrence.undo,
      { id: occurrenceId }
    )

    expect(data.occurrence.status).toBe('pending')
    expect(data.balanceAfter).toBe(0)
    const points = eventsOf('points.changed')[0] as { balance: number; entry: unknown }
    expect(points.balance).toBe(0)
    expect(points.entry).toBeNull()
    // 冲销行 + 原发分行
    expect(ledgerRepo.countAll()).toBe(2)
  })

  it('occurrence.skip → 只广播 occurrence.updated，不计分', () => {
    const { occurrenceId } = dailyToday()
    events = []

    const data = callOk<{ status: string; note: string | null }>(CH.occurrence.skip, {
      id: occurrenceId,
      note: '今天跳过'
    })

    expect(data.status).toBe('skipped')
    expect(data.note).toBe('今天跳过')
    expect(eventsOf('occurrence.updated').length).toBe(1)
    expect(eventsOf('points.changed')).toEqual([])
    expect(pointsService.balance()).toBe(0)
  })

  it('occurrence.skip 对已完成的打卡不写库、不广播', () => {
    const { occurrenceId } = dailyToday()
    callOk(CH.occurrence.complete, { id: occurrenceId })
    events = []

    const data = callOk<{ status: string }>(CH.occurrence.skip, { id: occurrenceId })
    expect(data.status).toBe('done')
    expect(events).toEqual([])
  })

  it('occurrence.complete 不存在的 id → NOT_FOUND「打卡记录不存在」', () => {
    const result = call(CH.occurrence.complete, { id: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND')
      expect(result.error.message).toBe('打卡记录不存在')
    }
  })

  it('四条的入参形状非法 → 统一 INVALID_INPUT，不抛到渲染层', () => {
    for (const channel of [CH.occurrence.complete, CH.occurrence.undo, CH.occurrence.skip]) {
      const result = call(channel, { id: 1 })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT')
    }
    const bad = call(CH.task.complete, { id: 'x' }) // 既无 quality 也无 noPoints
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_INPUT')
  })

  it('补做的往日完成：流水记在那一天，今天的今日积分不受影响', () => {
    const task = taskService.createTask({ type: 'daily', title: '跑步', source: 'manual' })
    const today = todayLocalDay()
    const yesterday = addDays(today, -1)
    occurrenceRepo.insertIfAbsent(task.id, yesterday, new Date().toISOString())
    const occ = occurrenceRepo.listByTask(task.id).find(o => o.day === yesterday)
    if (!occ) throw new Error('没有昨天的 occurrence')

    callOk(CH.occurrence.complete, { id: occ.id })

    expect(ledgerRepo.list({ from: yesterday, to: yesterday })).toHaveLength(1)
    expect(pointsService.todayStat().points).toBe(0)
  })
})
