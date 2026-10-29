import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CH } from '@shared/channels'
import type { DomainEvent } from '@shared/types/events'
import type { Task } from '@shared/types/domain'
import { setTransport } from '../../src/main/bus'
import * as taskService from '../../src/main/services/taskService'
import { addDays, todayLocalDay } from '../../src/main/db/localDay'
import * as occurrenceRepo from '../../src/main/db/repositories/occurrenceRepo'
import { createHandlers, type IpcLike } from '../../src/main/ipc/registry'
import type { IpcResult } from '../../src/shared/types/ipc'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/**
 * task.createManual 的补行口径（23 号开工词问题 1）：
 * 建 daily 立刻有今天 1 条 pending occurrence；限时/活动 0 条；不污染未来；事件只带今天。
 * 假 ipc + 假 transport + 内存库，模式同 promoteDraft.test.ts。
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

describe('task.createManual：daily 建完立刻可见（23 号开工词）', () => {
  let wired: Map<string, (input: unknown) => unknown>
  let events: DomainEvent[]

  const callOk = (channel: string, input?: unknown): unknown => {
    const fn = wired.get(channel)
    if (!fn) throw new Error(`通道未注册: ${channel}`)
    const result = fn(input) as IpcResult<unknown>
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

  it('service 层直测：建 daily 返回今天 1 条 occurrence；限时 0 条', () => {
    const { task, createdOccurrences } = taskService.createManualTask({
      type: 'daily',
      title: '每天背单词'
    })
    expect(task.type).toBe('daily')
    expect(createdOccurrences).toHaveLength(1)
    expect(createdOccurrences[0].day).toBe(todayLocalDay())
    expect(createdOccurrences[0].status).toBe('pending')

    const deadline = taskService.createManualTask({ type: 'deadline', title: '交作业' })
    expect(deadline.createdOccurrences).toHaveLength(0)
  })

  it('通道层：建 daily → 不打开日历今天就有 1 条 pending，事件只带今天这一条', () => {
    const task = callOk(CH.task.createManual, { type: 'daily', title: '每天背单词' }) as Task
    const today = todayLocalDay()

    const rows = occurrenceRepo.listByTask(task.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].day).toBe(today)
    expect(rows[0].status).toBe('pending')

    const created = eventsOf('occurrence.created')
    expect(created).toHaveLength(1)
    if (created[0].type !== 'occurrence.created') throw new Error('unreachable')
    expect(created[0].occurrences.map(o => o.day)).toEqual([today])

    // task.created / daystats.changed 仍按原顺序发
    expect(eventsOf('task.created')).toHaveLength(1)
    expect(eventsOf('daystats.changed')).toHaveLength(1)
  })

  it('建限时 / 活动任务：不产生任何 occurrence 行，也不发 occurrence.created', () => {
    for (const type of ['deadline', 'event'] as const) {
      const task = callOk(CH.task.createManual, { type, title: `${type}-任务` }) as Task
      expect(occurrenceRepo.listByTask(task.id)).toHaveLength(0)
    }
    expect(eventsOf('occurrence.created')).toHaveLength(0)
  })

  it('连续建 3 条每日任务：今天 3 行、互不重复（ensureRange 幂等，不出双行）', () => {
    for (const title of ['每天跑步', '每天早读', '每天复盘']) {
      callOk(CH.task.createManual, { type: 'daily', title })
    }
    const today = todayLocalDay()
    const rows = occurrenceRepo.listByDay(today)
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(o => o.taskId)).size).toBe(3)
    expect(rows.every(o => o.day === today && o.status === 'pending')).toBe(true)
  })

  it('不污染未来：occurrence 表里只有今天那一行，没有明天 / 后天', () => {
    const task = callOk(CH.task.createManual, { type: 'daily', title: '每天背单词' }) as Task
    expect(occurrenceRepo.countAll()).toBe(1)
    expect(occurrenceRepo.listByTask(task.id).map(o => o.day)).toEqual([todayLocalDay()])
  })

  it('activeFrom 在未来：今天没有行、不发 occurrence.created（"没有新建就不发"）', () => {
    callOk(CH.task.createManual, {
      type: 'daily',
      title: '下周开始',
      patch: { activeFrom: addDays(todayLocalDay(), 1) }
    })
    expect(occurrenceRepo.countAll()).toBe(0)
    expect(eventsOf('occurrence.created')).toHaveLength(0)
  })
})
