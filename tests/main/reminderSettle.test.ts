import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DomainEvent } from '@shared/types/events'
import { setTransport } from '../../src/main/bus'
import * as alertService from '../../src/main/services/alertService'
import * as messageService from '../../src/main/services/messageService'
import { closeTestDb, expectErrorCode, openMemoryDb } from '../db/helpers'

/**
 * 提醒消息「已处理」落库（v0.92）。
 *
 * 只测 messageService + alertService 的库内事实；不启窗口、不跑调度。
 * 总线用 `setTransport` 收口，避免默认实现去枚举 BrowserWindow。
 */

let events: DomainEvent[] = []

beforeEach(() => {
  openMemoryDb()
  events = []
  setTransport(event => events.push(event))
})

afterEach(() => {
  setTransport(null)
  closeTestDb()
})

/** 造一条 `kind='reminder'` 的消息（meta 与 reminders 行同口径） */
function appendReminder(id: string, reminderId = 'r1'): string {
  messageService.appendMessage({
    id,
    role: 'system',
    kind: 'reminder',
    meta: {
      kind: 'reminder',
      reminderId,
      taskId: null,
      title: '交报告',
      fireAt: '2026-11-07T09:00:00.000Z',
      offsetMin: null
    }
  })
  return id
}

describe('settleReminderMessage', () => {
  it('写 settled_at 并广播 patch，回读是同一个值', () => {
    const id = appendReminder('m-rem-1')

    const settled = messageService.settleReminderMessage(id)
    expect(settled.settledAt).not.toBeNull()

    const reloaded = messageService.getMessage(id)
    expect(reloaded?.settledAt).toBe(settled.settledAt)

    const patched = events.filter(
      (e): e is Extract<DomainEvent, { type: 'message.patch' }> => e.type === 'message.patch'
    )
    expect(patched).toHaveLength(1)
    expect(patched[0].messageId).toBe(id)
    expect(patched[0].patch.settledAt).toBe(settled.settledAt)
  })

  it('连调两次：第二次返回的 settledAt 与第一次相同，不刷新时间戳', () => {
    const id = appendReminder('m-rem-2')

    const first = messageService.settleReminderMessage(id)
    const second = messageService.settleReminderMessage(id)
    expect(second.settledAt).toBe(first.settledAt)
    // 幂等路径不写库、不广播
    expect(events).toHaveLength(1)
  })

  it('顺带 ack 对应的 alert 行', () => {
    alertService.recordAlert({ level: 'normal', sourceId: 'r1', title: 'x' })
    const id = appendReminder('m-rem-3', 'r1')

    messageService.settleReminderMessage(id)

    const rows = alertService.listSince(60_000, new Date())
    expect(rows).toHaveLength(1)
    expect(rows[0].ackedAt).not.toBeNull()
  })

  it('kind=text → INVALID_INPUT', () => {
    messageService.appendMessage({ id: 'm-text', role: 'user', kind: 'text', contentMd: '你好' })
    expectErrorCode(() => messageService.settleReminderMessage('m-text'), 'INVALID_INPUT')
  })

  it('不存在的 id → NOT_FOUND', () => {
    expectErrorCode(() => messageService.settleReminderMessage('没有这条'), 'NOT_FOUND')
  })
})
