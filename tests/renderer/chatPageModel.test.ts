import { describe, expect, it } from 'vitest'
import type { Message } from '../../src/shared/types/domain'
import { mergeOlderPage } from '../../src/renderer/main/features/chat/pageModel'

/** 最小可用消息：只用到 id，其余按 Message 契约补齐（不写 as any） */
function msg(id: string): Message {
  return {
    id,
    threadId: 'thread-1',
    role: 'user',
    kind: 'text',
    contentMd: id,
    meta: { kind: 'none' },
    linkedTaskId: null,
    status: 'sent',
    mode: 'chat',
    attachments: [],
    settledAt: null,
    createdAt: '2026-11-06T00:00:00.000Z'
  }
}

describe('聊天历史翻页合并（v0.89）', () => {
  it('page 在前、existing 在后，且丢掉 existing 里与 page 重复的 id', () => {
    const m1 = msg('m1')
    const m2 = msg('m2')
    const m3 = msg('m3')
    const m4 = msg('m4')

    const result = mergeOlderPage([m3, m4], [m1, m2, m3], 3)

    expect(result.messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(result.hasMore).toBe(true)
  })

  it('hasMore 三种边界，且不改动传入的数组', () => {
    const existing = [msg('m3'), msg('m4')]
    const existingIds = existing.map(message => message.id)

    const full = mergeOlderPage(existing, [msg('m1'), msg('m2')], 2)
    expect(full.hasMore).toBe(true)
    expect(existing).toHaveLength(2)
    expect(existing.map(message => message.id)).toEqual(existingIds)

    const short = mergeOlderPage(existing, [msg('m1')], 2)
    expect(short.hasMore).toBe(false)
    expect(existing).toHaveLength(2)
    expect(existing.map(message => message.id)).toEqual(existingIds)

    const empty = mergeOlderPage(existing, [], 2)
    expect(empty.hasMore).toBe(false)
    expect(empty.messages.map(message => message.id)).toEqual(existingIds)
    expect(existing).toHaveLength(2)
    expect(existing.map(message => message.id)).toEqual(existingIds)
  })
})
