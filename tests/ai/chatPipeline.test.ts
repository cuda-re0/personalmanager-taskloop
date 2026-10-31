import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@shared/types/events'
import type { Memory, Persona } from '@shared/types/domain'
import { setTransport } from '../../src/main/bus'
import { buildChatRequest, buildChatSystem } from '../../src/main/ai/pipelines/chat'
import * as aiService from '../../src/main/services/aiService'
import * as messageService from '../../src/main/services/messageService'
import { closeTestDb, openMemoryDb } from '../db/helpers'
import { scriptedProvider, waitFor } from './helpers'

/**
 * chat 管线（03 §4.3）与 `msg.send` 的模式分派。
 *
 * 这里验的是**分派与拼装**：不传 `mode` 必须走 chat（纯文本、不出草稿卡），
 * system 五段按顺序拼、本轮输入只进一次。
 */
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

let events: DomainEvent[] = []

beforeEach(() => {
  openMemoryDb()
  events = []
  setTransport(event => events.push(event))
})

afterEach(() => {
  aiService.setProvider(null)
  setTransport(null)
  closeTestDb()
})

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'default',
    name: '小助手',
    userCall: '',
    personaMd: '',
    tone: 'warm',
    isActive: true,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    ...overrides
  }
}

function makeMemory(contentMd: string): Memory {
  return {
    id: contentMd,
    contentMd,
    kind: 'fact',
    source: 'auto',
    hits: 0,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z'
  }
}

describe('buildChatSystem / buildChatRequest（03 §4.3.1）', () => {
  it('五段顺序：身份 → 记忆 → 今日数据 → 摘要 → 铁律', () => {
    const system = buildChatSystem({
      persona: makePersona({ userCall: '小明', personaMd: '你叫小助手。', tone: 'plain' }),
      memories: [makeMemory('养了一只猫叫豆豆')],
      brief: '今天是 2026-10-31（周六）。',
      summaryMd: '更早聊过工作。'
    })
    const idxIdentity = system.indexOf('你是小助手。')
    const idxMemory = system.indexOf('关于对方，你记得这些：')
    const idxBrief = system.indexOf('今天是 2026-10-31')
    const idxSummary = system.indexOf('更早的对话摘要：')
    const idxRules = system.indexOf('规则：')
    expect(idxIdentity).toBe(0)
    expect(idxMemory).toBeGreaterThan(idxIdentity)
    expect(idxBrief).toBeGreaterThan(idxMemory)
    expect(idxSummary).toBeGreaterThan(idxBrief)
    expect(idxRules).toBeGreaterThan(idxSummary)
    // 语气句逐字（03 §4.3.1，不许自由发挥）
    expect(system).toContain('语气：直接说结论，不铺垫、不客套')
    expect(system).toContain('称呼对方为「小明」。')
  })

  it('没有记忆、没有摘要时两段整段省略', () => {
    const system = buildChatSystem({
      persona: makePersona(),
      memories: [],
      brief: '今天没有任何任务。',
      summaryMd: ''
    })
    const sections = system.split('\n\n')
    expect(sections[0]).toContain('你是小助手')
    // 身份之后直接就是今日数据段：记忆段与摘要段整段不出现
    expect(sections[1]).toBe('今天没有任何任务。')
    expect(system).not.toContain('更早的对话摘要')
  })

  it('请求体：system + 历史（跳过空内容）+ 本轮输入', () => {
    const messages = buildChatRequest({
      persona: makePersona(),
      memories: [],
      brief: '今天没有任何任务。',
      summaryMd: '',
      recent: [
        {
          id: 'u1',
          threadId: 'main',
          role: 'user',
          kind: 'text',
          contentMd: '在吗',
          meta: { kind: 'none' },
          linkedTaskId: null,
          status: 'sent',
          attachments: [],
          createdAt: '2026-10-30T00:00:00.000Z'
        },
        {
          id: 'a1',
          threadId: 'main',
          role: 'assistant',
          kind: 'text',
          contentMd: '',
          meta: { kind: 'none' },
          linkedTaskId: null,
          status: 'pending',
          attachments: [],
          createdAt: '2026-10-30T00:00:01.000Z'
        }
      ],
      text: '今天还有什么事'
    })
    expect(messages).toHaveLength(3)
    expect(messages[0].role).toBe('system')
    expect(messages[1]).toMatchObject({ role: 'user', content: '在吗' })
    expect(messages[2]).toMatchObject({ role: 'user', content: '今天还有什么事' })
  })
})

describe('msg.send 的 mode 分派（02 §3.3）', () => {
  it('不传 mode → 走 chat 管线：回复是纯文本，不产草稿卡', async () => {
    const provider = scriptedProvider([() => ({ memories: [] })])
    provider.replies = ['今天没什么事，先歇会儿吧。']
    aiService.setProvider(provider)

    const { assistantMessageId } = aiService.send({ text: '我今天还有什么事' })

    await waitFor(() => messageService.getMessage(assistantMessageId)?.contentMd !== '')
    expect(provider.textOptions).toHaveLength(1)

    const assistant = messageService.requireMessage(assistantMessageId)
    expect(assistant.kind).toBe('text')
    expect(assistant.contentMd).toBe('今天没什么事，先歇会儿吧。')
    expect(assistant.status).toBe('sent')

    const drafts = messageService.recentMessages(20).filter(m => m.kind === 'task_draft')
    expect(drafts).toHaveLength(0)

    // 本轮用户输入只进一次 prompt（历史里排掉了刚落的这条）
    const texts = provider.textOptions[0].messages.filter(m => m.content === '我今天还有什么事')
    expect(texts).toHaveLength(1)
    expect(provider.textOptions[0].messages[0].role).toBe('system')

    await waitFor(() => events.some(e => e.type === 'ai.status' && e.phase === 'idle'))
  })
})
