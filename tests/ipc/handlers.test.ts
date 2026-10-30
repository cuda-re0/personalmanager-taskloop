import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import { CH } from '@shared/channels'
import type { Bootstrap } from '@shared/types/ipc'
import type { DomainEvent } from '@shared/types/events'
import { setTransport } from '../../src/main/bus'
import * as messageService from '../../src/main/services/messageService'
import * as taskService from '../../src/main/services/taskService'
import { todayLocalDay } from '../../src/main/db/localDay'
import { createHandlers, WIRED_CHANNELS, type IpcLike } from '../../src/main/ipc/registry'
import type { IpcResult } from '../../src/shared/types/ipc'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/**
 * ELECTRON_RUN_AS_NODE 下没有真实 electron 运行时：app/shell/BrowserWindow 都是 undefined。
 * openExternal 的放行分支要断言真的调了 shell.openExternal，所以这里 mock 掉整个模块
 * （本文件其余用例不依赖真实 electron 行为，替换无副作用）。
 */
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

/**
 * 假 ipc：只实现 createHandlers 需要的 { handle }。
 * npm test 在 ELECTRON_RUN_AS_NODE 下跑，没有 ipcMain / BrowserWindow，
 * 这正是 registry 可注入的设计目的。
 */
function makeFakeIpc(): IpcLike & { registered: string[] } {
  const registered: string[] = []
  return {
    registered,
    handle(channel) {
      registered.push(channel)
    }
  }
}

describe('IPC handlers（假 ipc + 假 transport + 内存库）', () => {
  let wired: Map<string, (input: unknown) => unknown>
  let events: DomainEvent[]

  const call = (channel: string, input?: unknown): IpcResult<unknown> => {
    const fn = wired.get(channel)
    if (!fn) throw new Error(`通道未注册: ${channel}`)
    return fn(input) as IpcResult<unknown>
  }

  /** 期望成功的调用：失败直接炸出错误码，返回 data（同时收窄了类型） */
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

  it('把 WIRED 全部 42 条注册进注入的 ipc', () => {
    expect(wired.size).toBe(42)
    for (const ch of WIRED_CHANNELS) expect(wired.has(ch)).toBe(true)
  })

  it('app.getBootstrap 返回全量快照字段，且不广播任何事件', () => {
    taskService.createTask({ type: 'deadline', title: '写周报', dueAt: '2026-11-02T02:00:00.000Z' })
    const data = callOk(CH.app.getBootstrap) as Bootstrap
    expect(Object.keys(data).sort()).toEqual(
      [
        'balance',
        'channels',
        'messages',
        'monthIndex',
        'recentLedger',
        'settings',
        'tasks',
        'today',
        'todayOccurrences'
      ].sort()
    )
    expect(data.tasks.map(t => t.title)).toEqual(['写周报'])
    expect(data.balance).toBe(0)
    // Bootstrap.channels 在 W9 前恒为 []，不许返回假可用性
    expect(data.channels).toEqual([])
    // getBootstrap 是全量快照，例外条款：不广播
    expect(events).toEqual([])
  })

  it('occurrence.today 第一次广播 occurrence.created，第二次不广播', () => {
    taskService.createTask({ type: 'daily', title: '喝水', source: 'manual' })

    const first = callOk(CH.occurrence.today) as unknown[]
    expect(first.length).toBe(1)
    const createdEvents = eventsOf('occurrence.created')
    expect(createdEvents.length).toBe(1)
    expect((createdEvents[0] as { occurrences: unknown[] }).occurrences.length).toBe(1)

    events = []
    const second = callOk(CH.occurrence.today) as unknown[]
    expect(second.length).toBe(1)
    expect(eventsOf('occurrence.created')).toEqual([])
  })

  it('occurrence.listByRange 补缺口时广播新建的那些 occurrence', () => {
    taskService.createTask({ type: 'daily', title: '背单词', source: 'manual' })
    const today = todayLocalDay()
    callOk(CH.occurrence.listByRange, { from: today, to: today })
    const created = eventsOf('occurrence.created')
    expect(created.length).toBe(1)
    expect((created[0] as { occurrences: { day: string }[] }).occurrences[0].day).toBe(today)
  })

  it('task.createManual → task.created + daystats.changed（两条都发）', () => {
    callOk(CH.task.createManual, { type: 'daily', title: '拉伸' })
    const created = eventsOf('task.created')
    expect(created.length).toBe(1)
    expect((created[0] as { task: { title: string } }).task.title).toBe('拉伸')

    const daystats = eventsOf('daystats.changed')
    expect(daystats.length).toBe(1)
    // DomainEvent 里 daystats.changed 的 day 字段是 DayStat 对象（不是字符串）
    expect((daystats[0] as { day: { day: string } }).day.day).toBe(todayLocalDay())
  })

  it('task.update 广播的 changed 是真实差异（含 title，不含没动的 sortKey）', () => {
    const task = taskService.createTask({ type: 'deadline', title: '旧标题' })
    events = []

    callOk(CH.task.update, { id: task.id, patch: { title: '新标题' } })
    const updated = eventsOf('task.updated')
    expect(updated.length).toBe(1)
    const changed = (updated[0] as { changed: string[] }).changed
    expect(changed).toContain('title')
    expect(changed).not.toContain('sortKey')
  })

  it('task.update 改不存在的任务 → NOT_FOUND「任务不存在」，且不广播', () => {
    const result = call(CH.task.update, { id: 'nope', patch: { title: 'x' } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('NOT_FOUND')
      expect(result.error.message).toBe('任务不存在')
    }
    expect(events).toEqual([])
  })

  it('非法入参经守卫转 INVALID_INPUT「请求参数格式不正确」，不抛异常', () => {
    const result = call(CH.task.get, { id: 123 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT')
      expect(result.error.message).toBe('请求参数格式不正确')
    }
    expect(events).toEqual([])
  })

  it('calendar.dayIndex 的 month 出界 → INVALID_INPUT（1..12 整数）', () => {
    const result = call(CH.calendar.dayIndex, { year: 2026, month: 13 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT')
  })

  it('points.adjust → points.changed（balance/entry/today 都在载荷里）', () => {
    callOk(CH.points.adjust, { delta: 5, reason: '手工补分' })
    const changed = eventsOf('points.changed')
    expect(changed.length).toBe(1)
    const payload = changed[0] as { balance: number; entry: { delta: number }; today: unknown }
    expect(payload.balance).toBe(5)
    expect(payload.entry.delta).toBe(5)
    expect(payload.today).toMatchObject({ day: todayLocalDay() })
  })

  it('points.preview / streakPreview 是纯计算：不写流水、不广播', () => {
    expect(callOk(CH.points.preview, { type: 'deadline', difficulty: 'medium' })).toBe(20)
    expect(callOk(CH.points.streakPreview, { current: 6, nextDayWillReach: 7 })).toBe(5)
    expect(events).toEqual([])
  })

  // 两条背靠背 appendMessage 常落在同一毫秒；repo 的排序 tiebreaker 是 rowid（插入序），
  // 排序是全序，不再依赖随机 id（同毫秒对与翻页的专项断言在 tests/db/message.test.ts）
  it('msg.list 返回消息（升序）', () => {
    messageService.appendMessage({ role: 'user', kind: 'text', contentMd: '第一句' })
    messageService.appendMessage({ role: 'assistant', kind: 'text', contentMd: '第二句' })
    const messages = callOk(CH.msg.list, { limit: 10 }) as { contentMd: string }[]
    expect(messages.map(m => m.contentMd)).toEqual(['第一句', '第二句'])
  })

  it('task.remove 软删后广播 task.removed；重复删除幂等（softRemove 不查状态）', () => {
    const task = taskService.createTask({ type: 'event', title: '例会' })
    events = []

    callOk(CH.task.remove, { id: task.id })
    expect(eventsOf('task.removed').length).toBe(1)

    // W1 的 softRemove 对已删任务再删一次也成功（WHERE 只按 id，updated_at 变了照样命中），
    // 幂等 no-op，不算缺口但记录在案
    callOk(CH.task.remove, { id: task.id })
  })

  it('task.reorder 的 changed 走 diffKeys：sortKey 与 updatedAt 都在（审核 P2）', async () => {
    const a = taskService.createTask({ type: 'deadline', title: '甲' })
    taskService.createTask({ type: 'deadline', title: '乙' })
    // updated_at 是毫秒级 ISO 字符串：同毫秒内 reorder 写的值与 before 相同，diffKeys 比不出差异。
    // 跨过毫秒边界才能让真实差异显形
    await new Promise(resolve => setTimeout(resolve, 5))
    events = []

    callOk(CH.task.reorder, { id: a.id, beforeId: null })
    const updated = eventsOf('task.updated')
    expect(updated.length).toBe(1)
    const changed = (updated[0] as { changed: string[] }).changed
    expect(changed).toContain('sortKey')
    expect(changed).toContain('updatedAt')
  })

  it('app.setSetting 写入并广播 app.setting.changed', () => {
    callOk(CH.app.setSetting, { key: 'app.theme', value: 'dark' })
    const changed = eventsOf('app.setting.changed')
    expect(changed.length).toBe(1)
    expect(changed[0]).toMatchObject({ key: 'app.theme', value: 'dark' })
    // 写进去了：getBootstrap 能读回
    const boot = callOk(CH.app.getBootstrap) as Bootstrap
    expect(boot.settings['app.theme']).toBe('dark')
  })

  it('app.setSetting 未登记的 key → INVALID_INPUT「未知的配置项」，不广播', () => {
    const result = call(CH.app.setSetting, { key: 'nope.key', value: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_INPUT')
      expect(result.error.message).toBe('未知的配置项')
    }
    expect(events).toEqual([])
  })

  it('app.openExternal：http/https 放行并调 shell.openExternal', async () => {
    const mocked = vi.mocked(shell.openExternal)
    mocked.mockClear()
    callOk(CH.app.openExternal, { url: 'https://example.com/page?a=1' })
    callOk(CH.app.openExternal, { url: 'http://example.com' })
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(mocked).toHaveBeenNthCalledWith(1, 'https://example.com/page?a=1')
    expect(mocked).toHaveBeenNthCalledWith(2, 'http://example.com/')
  })

  it('app.openExternal：ftp: 与 javascript: 拒绝为「只允许打开 http/https 链接」', () => {
    for (const url of ['ftp://example.com/file', 'javascript:alert(1)']) {
      const result = call(CH.app.openExternal, { url })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_INPUT')
        expect(result.error.message).toBe('只允许打开 http/https 链接')
      }
    }
    expect(vi.mocked(shell.openExternal)).not.toHaveBeenCalledWith('ftp://example.com/file')
    expect(vi.mocked(shell.openExternal)).not.toHaveBeenCalledWith('javascript:alert(1)')
  })
})
