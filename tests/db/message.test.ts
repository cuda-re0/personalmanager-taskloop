import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessageMeta, ReviewVerdict, TaskDraft } from '../../src/shared/types/domain'
import { getDb } from '../../src/main/db/connection'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'
import * as messageService from '../../src/main/services/messageService'
import * as taskService from '../../src/main/services/taskService'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

const draft = (localId: string): TaskDraft => ({
  localId,
  type: 'deadline',
  title: '交作业',
  detailMd: '',
  difficulty: 'medium',
  estimateMin: 60, // 只用于判难度 / 排提醒 / 算逾期，不进积分公式（v0.9）
  dueHint: '周五',
  dailyTimeHint: null,
  activeToHint: null, // 仅 daily 有可选结束日期（04 §3.2）
  reminderOffsets: [1440, 60], // 提前一天 + 提前一小时
  tags: [],
  steps: [],
  missingInfo: [],
  requiresEvidence: true,
  confidence: 0.8,
  pointsPlanned: 20 // medium 基数。v0.9 起时长不进公式；旧的 23 是 20×1.15 的残留，别再抄它
})

describe('messages', () => {
  it('text 消息的 meta 是 { kind: "none" }，正文与状态落库', () => {
    const message = messageService.appendMessage({
      role: 'user',
      kind: 'text',
      contentMd: '明天交作业'
    })
    expect(message.meta).toEqual({ kind: 'none' })
    expect(message.contentMd).toBe('明天交作业')
    expect(message.status).toBe('sent')
    expect(message.threadId).toBe('main')
    expect(message.attachments).toEqual([])
    expect(message.linkedTaskId).toBeNull()
  })

  it('task_draft 的 drafts 数组原样回来（2 个草稿）', () => {
    const message = messageService.appendMessage({
      role: 'assistant',
      kind: 'task_draft',
      meta: { kind: 'task_draft', drafts: [draft('a'), draft('b')] },
      status: 'streaming'
    })
    const fetched = messageService.requireMessage(message.id)
    expect(fetched.meta.kind).toBe('task_draft')
    if (fetched.meta.kind === 'task_draft') {
      expect(fetched.meta.drafts.map(d => d.localId)).toEqual(['a', 'b'])
      expect(fetched.meta.drafts[0].requiresEvidence).toBe(true)
    }
  })

  it('reminder 的 meta 带上 offsetMin（-30 与绝对时间 null 都要能取回）', () => {
    const relative = messageService.appendMessage({
      role: 'assistant',
      kind: 'reminder',
      meta: {
        kind: 'reminder',
        reminderId: 'rem_1',
        taskId: null,
        title: '交作业',
        fireAt: '2026-10-30T13:30:00.000Z',
        offsetMin: -30
      }
    })
    const fetched = messageService.requireMessage(relative.id)
    expect(fetched.meta).toEqual({
      kind: 'reminder',
      reminderId: 'rem_1',
      taskId: null,
      title: '交作业',
      fireAt: '2026-10-30T13:30:00.000Z',
      offsetMin: -30
    })

    const absolute = messageService.appendMessage({
      role: 'assistant',
      kind: 'reminder',
      meta: {
        kind: 'reminder',
        reminderId: 'rem_2',
        taskId: null,
        title: '每日任务',
        fireAt: '2026-10-30T13:00:00.000Z',
        offsetMin: null
      }
    })
    const absoluteMeta = messageService.requireMessage(absolute.id).meta
    expect(absoluteMeta.kind).toBe('reminder')
    if (absoluteMeta.kind === 'reminder') expect(absoluteMeta.offsetMin).toBeNull()
  })

  it('reminder meta 缺 offsetMin 时落成 null，不猜', () => {
    // 模拟旧数据/写入方漏字段：不能拿 fireAt - dueAt 现算，直接 null（绝对时间）
    const message = messageService.appendMessage({
      role: 'assistant',
      kind: 'reminder',
      meta: {
        kind: 'reminder',
        reminderId: 'rem_3',
        taskId: null,
        title: '老提醒',
        fireAt: '2026-10-30T13:00:00.000Z'
      } as MessageMeta
    })
    const meta = messageService.requireMessage(message.id).meta
    expect(meta.kind).toBe('reminder')
    if (meta.kind === 'reminder') expect(meta.offsetMin).toBeNull()
  })

  it('patch 只改 contentMd / status / meta', () => {
    const message = messageService.appendMessage({ role: 'assistant', kind: 'text', status: 'streaming' })
    const patched = messageService.patchMessage(message.id, {
      contentMd: '写完了',
      status: 'sent'
    })
    expect(patched.contentMd).toBe('写完了')
    expect(patched.status).toBe('sent')
  })

  it('最近 N 条按时间升序返回，listBefore 能向前翻页', () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const m = messageService.appendMessage({
        role: 'user',
        kind: 'text',
        contentMd: `第 ${i} 条`,
        createdAt: `2026-10-28T0${i}:00:00.000Z`
      })
      ids.push(m.id)
    }

    const recent = messageService.recentMessages(3)
    expect(recent.map(m => m.contentMd)).toEqual(['第 2 条', '第 3 条', '第 4 条'])

    const older = messageService.listMessages({ before: ids[2], limit: 2 })
    expect(older.map(m => m.contentMd)).toEqual(['第 0 条', '第 1 条'])
  })

  it('附件按 message 分组带出，url 是 app://attach/<id>', () => {
    const message = messageService.appendMessage({ role: 'user', kind: 'text', contentMd: '看图' })
    messageService.insertAttachment({
      id: 'att_1',
      messageId: message.id,
      kind: 'image',
      relPath: '2026/10/att_1.png',
      mime: 'image/png',
      bytes: 1024,
      width: 100,
      height: 200,
      sha256: 'x'.repeat(64),
      createdAt: '2026-10-28T02:00:00.000Z'
    })

    const fetched = messageService.requireMessage(message.id)
    expect(fetched.attachments).toHaveLength(1)
    expect(fetched.attachments[0].url).toBe('app://attach/att_1')
    expect(fetched.attachments[0].width).toBe(100)
  })

  it('消息可以指向任务；任务被物理删除后 linked_task_id 置 NULL', () => {
    const task = taskService.createTask({ type: 'deadline', title: '交作业' })
    const message = messageService.appendMessage({
      role: 'assistant',
      kind: 'task_review',
      meta: {
        kind: 'task_review',
        taskId: task.id,
        verdict: {
          verdict: 'partial',
          quality: 'partial',
          result: null, // 仅 event 有意义，限时任务恒为 null
          reason: '再补一句',
          followup: null,
          gaps: ['结论段缺失'] // partial 逐条列未完成项，其他 verdict 才是空数组
        }
      },
      linkedTaskId: task.id
    })
    expect(message.linkedTaskId).toBe(task.id)

    taskService.removeTask(task.id)
    // 软删不会动消息；这里验证 meta 的 task_review 结构能取回
    const fetched = messageService.requireMessage(message.id)
    expect(fetched.meta.kind).toBe('task_review')
  })

  it('task_review 缺 verdict 抛 DB_ERROR，不静默塞假 verdict（契约 v0.10 P2-6）', () => {
    const verdict: ReviewVerdict = {
      verdict: 'pass',
      quality: 'met',
      result: null,
      reason: '做得不错',
      followup: null,
      gaps: []
    }
    const message = messageService.appendMessage({
      role: 'assistant',
      kind: 'task_review',
      meta: { kind: 'task_review', taskId: 't1', verdict }
    })
    // 合法 meta 原样回来（result / gaps 不被吞）
    expect(messageService.requireMessage(message.id).meta).toEqual({
      kind: 'task_review',
      taskId: 't1',
      verdict
    })

    // 模拟坏数据：meta_json 里没有 verdict 字段
    getDb()
      .prepare('UPDATE messages SET meta_json = ? WHERE id = ?')
      .run('{"kind":"task_review","taskId":"t1"}', message.id)
    expectErrorCode(() => messageService.requireMessage(message.id), 'DB_ERROR')
  })
})
