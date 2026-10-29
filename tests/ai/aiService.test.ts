import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DomainEvent } from '@shared/types/events'
import type { TaskDraft } from '@shared/types/domain'
import { setTransport } from '../../src/main/bus'
import { appError } from '../../src/main/db/errors'
import { getDb } from '../../src/main/db/connection'
import { AI_COPY } from '../../src/main/ai/copy'
import * as aiService from '../../src/main/services/aiService'
import * as messageService from '../../src/main/services/messageService'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from '../db/helpers'
import { hangingProvider, scriptedProvider, waitFor } from './helpers'

/**
 * aiService 的编排（开工词 §6 的第 6、11、12、13 条）。
 *
 * 测试宿主与 handlers.test.ts 同一套：假 electron + 内存库 + 收集型 transport。
 * **provider 全部注入**（`setProvider`），不打真网络。
 */
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

const PARSE_OK = {
  intent: 'create_task' as const,
  reply: '记成限时任务了，截止按明天下午三点填。',
  tasks: [
    {
      type: 'deadline' as const,
      title: '写季度报告初稿',
      detail_md: '整理数据后写初稿。',
      requires_evidence: true,
      difficulty: 'medium' as const,
      estimate_min: 90,
      due_hint: '2026-10-30T15:00:00+08:00',
      daily_time_hint: null,
      tags: ['工作'],
      steps: [],
      missing_info: [],
      confidence: 0.9
    }
  ]
}

function makeDraft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    localId: 'draft001',
    type: 'deadline',
    title: '写季度报告初稿',
    detailMd: '整理数据后写初稿。',
    difficulty: 'medium',
    estimateMin: 90,
    dueHint: '2026-10-30T07:00:00.000Z',
    dailyTimeHint: null,
    activeToHint: null,
    reminderOffsets: [-1440, -60],
    tags: ['工作'],
    steps: [],
    missingInfo: [],
    requiresEvidence: true,
    confidence: 0.9,
    pointsPlanned: 20,
    ...overrides
  }
}

function seedDraftMessage(drafts: TaskDraft[]): string {
  const message = messageService.appendMessage({
    role: 'assistant',
    kind: 'task_draft',
    contentMd: '记好了。',
    meta: { kind: 'task_draft', drafts }
  })
  return message.id
}

function phases(events: DomainEvent[]): string[] {
  return events
    .filter((e): e is Extract<DomainEvent, { type: 'ai.status' }> => e.type === 'ai.status')
    .map(e => e.phase)
}

describe('aiService', () => {
  let events: DomainEvent[]

  beforeEach(() => {
    openMemoryDb()
    events = []
    setTransport(event => events.push(event))
    aiService.resetForTest()
  })

  afterEach(() => {
    aiService.resetForTest()
    setTransport(null)
    closeTestDb()
  })

  it('send 立刻返回（provider 卡住也 <100ms），占位消息已落库', () => {
    aiService.setProvider(hangingProvider())
    aiService.setKeyProbe(() => true)

    const started = Date.now()
    const result = aiService.send({ text: '明天下午三点前把季度报告初稿写完' })
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(100)
    expect(messageService.getMessage(result.assistantMessageId)?.status).toBe('pending')
    expect(messageService.getMessage(result.userMessage.id)?.contentMd).toBe(
      '明天下午三点前把季度报告初稿写完'
    )
    // 用户消息与占位消息都广播了，并且 thinking 已经发出
    expect(events.filter(e => e.type === 'message.appended')).toHaveLength(2)
    expect(phases(events)).toEqual(['thinking'])
  })

  it('成功一轮：一句回复 + 一条草稿卡消息 + tokens 落到 messages + idle 收尾', async () => {
    aiService.setProvider(scriptedProvider([() => PARSE_OK]))

    const { assistantMessageId } = aiService.send({ text: '明天下午三点前把季度报告初稿写完' })
    await waitFor(() => phases(events).includes('idle'))

    // 占位消息原地 patch 成回复（kind 列是 text，改不了，所以草稿卡是另一条消息）
    const message = messageService.requireMessage(assistantMessageId)
    expect(message.status).toBe('sent')
    expect(message.kind).toBe('text')
    expect(message.meta.kind).toBe('none')
    expect(message.contentMd).toContain('记成限时任务了')

    const cards = messageService.listMessages({ limit: 10 }).filter(m => m.meta.kind === 'task_draft')
    expect(cards).toHaveLength(1)
    if (cards[0].meta.kind === 'task_draft') {
      expect(cards[0].meta.drafts).toHaveLength(1)
      expect(cards[0].meta.drafts[0].pointsPlanned).toBe(20)
      expect(cards[0].meta.drafts[0].reminderOffsets).toEqual([-1440, -60])
      expect(cards[0].meta.drafts[0].dueHint).toBe('2026-10-30T07:00:00.000Z')
    }
    expect(events.some(e => e.type === 'message.appended' && e.message.kind === 'task_draft')).toBe(
      true
    )

    // tokens 是内部埋点，不在 Message 契约里，直接读库
    const row = getDb()
      .prepare('SELECT tokens_in, tokens_out, latency_ms FROM messages WHERE id = ?')
      .get(assistantMessageId) as { tokens_in: number; tokens_out: number; latency_ms: number }
    expect(row.tokens_in).toBe(42)
    expect(row.tokens_out).toBe(128)
    expect(row.latency_ms).toBeGreaterThanOrEqual(0)

    // ai.status 时序：thinking 在前、idle 在后
    expect(phases(events)).toEqual(['thinking', 'idle'])
  })

  it('provider 失败：落一条 kind=error、retryable=true，且 idle 仍然发', async () => {
    aiService.setProvider(
      scriptedProvider([
        () => {
          throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, { retryable: true })
        }
      ])
    )

    const { assistantMessageId } = aiService.send({ text: '明天下午三点前把季度报告初稿写完' })
    await waitFor(() => phases(events).includes('idle'))

    const all = messageService.listMessages({ limit: 10 })
    const errorMessage = all.find(m => m.kind === 'error')
    expect(errorMessage).toBeDefined()
    expect(errorMessage?.role).toBe('system')
    if (errorMessage?.meta.kind === 'error') {
      expect(errorMessage.meta.code).toBe('AI_UPSTREAM_ERROR')
      expect(errorMessage.meta.retryable).toBe(true)
      expect(errorMessage.meta.message).toBe(AI_COPY.upstream)
    }
    // 占位消息标成 failed，不留一个永远转圈的 pending
    expect(messageService.requireMessage(assistantMessageId).status).toBe('failed')
    expect(phases(events)).toEqual(['thinking', 'idle'])
    // 失败也要广播 error 消息，否则渲染层看不到
    expect(events.some(e => e.type === 'message.appended' && e.message.kind === 'error')).toBe(true)
  })

  it('retry：找到失败那一轮的用户输入重跑，同一条 assistant 消息原地 patch', async () => {
    let attempt = 0
    aiService.setProvider(
      scriptedProvider([
        () => {
          attempt += 1
          if (attempt === 1) throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, { retryable: true })
          return PARSE_OK
        },
        () => PARSE_OK
      ])
    )

    const { assistantMessageId } = aiService.send({ text: '明天下午三点前把季度报告初稿写完' })
    await waitFor(() => phases(events).includes('idle'))

    const errorMessage = messageService.listMessages({ limit: 10 }).find(m => m.kind === 'error')
    expect(errorMessage).toBeDefined()

    aiService.retry({ messageId: errorMessage!.id })
    await waitFor(() => phases(events).filter(p => p === 'idle').length >= 2)

    const patched = messageService.requireMessage(assistantMessageId)
    expect(patched.status).toBe('sent')
    expect(patched.contentMd).toContain('记成限时任务了')
    // 没有新建"回复"消息（原地 patch）；草稿卡是独立一条，所以按 kind 分开数
    const all = messageService.listMessages({ limit: 20 })
    expect(all.filter(m => m.role === 'assistant' && m.kind === 'text')).toHaveLength(1)
    expect(all.filter(m => m.meta.kind === 'task_draft')).toHaveLength(1)
  })

  it('retry 的 messageId 不存在 → NOT_FOUND', () => {
    aiService.setProvider(scriptedProvider([() => PARSE_OK]))
    expectErrorCode(() => aiService.retry({ messageId: 'nope' }), 'NOT_FOUND')
  })

  it('rejectDrafts：逐个移除，空了把 meta 清成 none', () => {
    const messageId = seedDraftMessage([makeDraft(), makeDraft({ localId: 'draft002' })])

    aiService.rejectDrafts({ messageId, localIds: ['draft001'] })
    const afterFirst = messageService.requireMessage(messageId)
    expect(afterFirst.meta.kind).toBe('task_draft')
    if (afterFirst.meta.kind === 'task_draft') {
      expect(afterFirst.meta.drafts.map(d => d.localId)).toEqual(['draft002'])
    }

    aiService.rejectDrafts({ messageId, localIds: ['draft002'] })
    const afterAll = messageService.requireMessage(messageId)
    // kind 列不可 patch，所以"清空"表现为 drafts: []（卡片消失，容器为空）
    expect(afterAll.meta.kind).toBe('task_draft')
    if (afterAll.meta.kind === 'task_draft') expect(afterAll.meta.drafts).toEqual([])
    // 每次都要广播，否则另一个窗口的卡片不会消失
    expect(events.filter(e => e.type === 'message.patch')).toHaveLength(2)
  })

  it('rejectDrafts：localId 对不上 → INVALID_INPUT（不静默成功）', () => {
    const messageId = seedDraftMessage([makeDraft()])
    expectErrorCode(() => aiService.rejectDrafts({ messageId, localIds: ['ghost'] }), 'INVALID_INPUT')
  })

  it('confirmDraft：转调 taskService.promoteDraft 并广播 task.created', () => {
    const messageId = seedDraftMessage([makeDraft()])

    const task = aiService.confirmDraft({ messageId, localId: 'draft001' })
    expect(task.title).toBe('写季度报告初稿')
    expect(task.pointsPlanned).toBe(20)
    expect(task.status).toBe('todo')
    expect(events.some(e => e.type === 'task.created' && e.task.id === task.id)).toBe(true)

    // 幂等：第二次确认返回同一个任务，且不再广播 created
    const before = events.filter(e => e.type === 'task.created').length
    const again = aiService.confirmDraft({ messageId, localId: 'draft001' })
    expect(again.id).toBe(task.id)
    expect(events.filter(e => e.type === 'task.created').length).toBe(before)
  })

  it('review 硬闸门：要求证据但一条都没有 → need_evidence，provider 一次都没被调用', async () => {
    const provider = scriptedProvider([
      () => {
        throw new Error('硬闸门不该发请求')
      }
    ])
    aiService.setProvider(provider)

    const task = taskService.createTask({
      type: 'deadline',
      title: '交物理作业',
      requiresEvidence: true
    })

    const verdict = await aiService.review({ taskId: task.id })
    expect(verdict.verdict).toBe('need_evidence')
    expect(verdict.followup).not.toBeNull()
    expect(provider.calls).toBe(0)

    const reviewMessage = messageService.listMessages({ limit: 10 }).find(m => m.kind === 'task_review')
    expect(reviewMessage).toBeDefined()
    if (reviewMessage?.meta.kind === 'task_review') {
      expect(reviewMessage.meta.taskId).toBe(task.id)
      expect(reviewMessage.meta.verdict.verdict).toBe('need_evidence')
    }
  })

  it('review 有证据：走模型，event 的 quality 恒 met、result 保留', async () => {
    aiService.setProvider(
      scriptedProvider([
        () => ({
          verdict: 'pass',
          quality: 'met',
          result: 'exceeded',
          reason: '比赛拿了第三名，超出预期',
          followup: null
        })
      ])
    )

    const task = taskService.createTask({
      type: 'event',
      title: '参加英语六级考试',
      requiresEvidence: false
    })

    const verdict = await aiService.review({ taskId: task.id })
    expect(verdict.verdict).toBe('pass')
    expect(verdict.quality).toBe('met')
    expect(verdict.result).toBe('exceeded')
  })

  it('health：没 Key → configured=false 且不探测；有 provider → 真打一次图并缓存', async () => {
    aiService.setKeyProbe(() => false)
    expect(await aiService.health()).toMatchObject({ configured: false, multimodal: null })

    aiService.resetForTest()
    const provider = scriptedProvider([() => ({ color: '红色' })])
    aiService.setProvider(provider)

    const first = await aiService.health()
    expect(first.configured).toBe(true)
    expect(first.model).toBe('glm-5.3-flash')
    expect(first.multimodal).toBe(true)

    // 第二次不再调用（按进程缓存）
    await aiService.health()
    expect(provider.calls).toBe(1)
  })
})
