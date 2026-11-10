import { describe, expect, it } from 'vitest'
import type { Message, MessageMeta, ReviewVerdict } from '../../src/shared/types/domain'
import {
  layerOfKind,
  layersOfMessages,
  messagesOfLayer
} from '../../src/renderer/main/features/chat/layerModel'

/**
 * v0.69：会话区两层（聊天层只有文字，任务层只有卡）。
 * v0.73：消息带发送模式标签，v0.69 的三条用例默认 `mode: null`（= 老行，走轮推断），断言不变。
 * 纯函数测试，不碰组件、不碰 DOM。
 */

function msgOf(
  id: string,
  meta: MessageMeta,
  role: Message['role'] = 'assistant',
  mode: Message['mode'] = null
): Message {
  return {
    id,
    threadId: 'thread-demo',
    role,
    kind: 'text',
    contentMd: '',
    meta,
    linkedTaskId: null,
    status: 'sent',
    mode,
    attachments: [],
    settledAt: null,
    createdAt: '2026-11-04T00:00:00.000Z'
  }
}

describe('layerOfKind（v0.69）', () => {
  it('五个已知 kind 各归其层，未知 kind 兜底到聊天层', () => {
    expect(layerOfKind('none')).toBe('chat')
    expect(layerOfKind('error')).toBe('chat')
    expect(layerOfKind('task_draft')).toBe('task')
    expect(layerOfKind('task_review')).toBe('task')
    expect(layerOfKind('reminder')).toBe('task')
    // 将来才会出现的 kind：宁可多一条气泡，也不许把消息藏掉
    expect(layerOfKind('unknown_kind')).toBe('chat')
  })
})

describe('messagesOfLayer（v0.69）', () => {
  const DRAFT_META: MessageMeta = {
    kind: 'task_draft',
    drafts: [
      {
        localId: 'd1',
        type: 'deadline',
        title: '完成大物第15章作业',
        detailMd: '',
        difficulty: 'easy',
        estimateMin: null,
        dueHint: '2026-11-06',
        plannedDay: null,
        dailyTimeHint: null,
        activeToHint: null,
        reminderOffsets: [],
        tags: [],
        steps: [],
        missingInfo: [],
        requiresEvidence: false,
        confidence: 0.9,
        pointsPlanned: 2
      }
    ]
  }

  const REVIEW_VERDICT: ReviewVerdict = {
    verdict: 'pass',
    quality: 'met',
    result: null,
    reason: '',
    followup: null,
    gaps: []
  }

  /** 一轮任务对话 + 一轮纯聊天 + 两条轮外消息（顺序即 createdAt 顺序） */
  const MESSAGES: Message[] = [
    msgOf('e0', { kind: 'error', code: 'AI_UPSTREAM_ERROR', message: '上游超时', retryable: true }),
    msgOf('u1', { kind: 'none' }, 'user'),
    msgOf('t1', { kind: 'none' }),
    msgOf('d1', DRAFT_META),
    msgOf('u2', { kind: 'none' }, 'user'),
    msgOf('t2', { kind: 'none' }),
    msgOf('r1', {
      kind: 'reminder',
      reminderId: 'rem-1',
      taskId: null,
      title: '交作业',
      fireAt: '2026-11-05T01:00:00.000Z',
      offsetMin: -30
    })
  ]

  it('按「轮」判：任务轮里的文字也归任务层，纯聊天轮留在聊天层', () => {
    const layers = layersOfMessages(MESSAGES)

    // 每条消息都要有键
    expect(layers.size).toBe(MESSAGES.length)

    expect(messagesOfLayer(MESSAGES, layers, 'chat').map(m => m.id)).toEqual(['e0', 'u2', 't2'])
    expect(messagesOfLayer(MESSAGES, layers, 'task').map(m => m.id)).toEqual([
      'u1',
      't1',
      'd1',
      'r1'
    ])
    // 轮外消息只按基础层：error → chat，reminder → task
    expect(layers.get('e0')).toBe('chat')
    expect(layers.get('r1')).toBe('task')
  })

  it('全量判定不受可见性过滤影响：草稿卡被藏起来时整轮仍归任务层', () => {
    // 模拟「同一任务的旧审核卡被待提交卡替代」：可见数组里没有 d1 这张卡
    const visible = MESSAGES.filter(message => message.id !== 'd1')
    const layers = layersOfMessages(MESSAGES)

    expect(layers.get('u1')).toBe('task')
    expect(layers.get('t1')).toBe('task')
    expect(messagesOfLayer(visible, layers, 'task').map(m => m.id)).toEqual(['u1', 't1', 'r1'])
  })

  it('标签优先：任务模式无卡也归任务层，聊天模式有卡也留在聊天层，老行仍按轮兜底', () => {
    const messages: Message[] = [
      // ① 任务模式下发的，这一轮没有任何卡 —— 用户实际遇到的那条
      msgOf('u-task', { kind: 'none' }, 'user', 'task'),
      msgOf('t-task', { kind: 'none' }, 'assistant', 'task'),
      // ② 聊天模式下发的，但这一轮出了草稿卡 —— 标签压过轮推断
      msgOf('u-chat', { kind: 'none' }, 'user', 'chat'),
      msgOf('d-chat', DRAFT_META, 'assistant', 'chat'),
      // ③ 老行（无标签），这一轮有草稿卡 —— 轮推断兜底仍生效
      msgOf('u-old', { kind: 'none' }, 'user'),
      msgOf('t-old', { kind: 'none' }),
      msgOf('d-old', DRAFT_META),
      // ④ 卡片不受 mode 影响
      msgOf('v-chat', { kind: 'task_review', taskId: 'task-1', verdict: REVIEW_VERDICT }, 'assistant', 'chat')
    ]
    const layers = layersOfMessages(messages)

    expect(layers.size).toBe(messages.length)

    expect(layers.get('u-task')).toBe('task')
    expect(layers.get('t-task')).toBe('task')

    expect(layers.get('u-chat')).toBe('chat')
    // 卡片按 kind 永远是任务层，mode 拉不回聊天层
    expect(layers.get('d-chat')).toBe('task')

    expect(layers.get('u-old')).toBe('task')
    expect(layers.get('t-old')).toBe('task')

    expect(layers.get('v-chat')).toBe('task')
  })
})
