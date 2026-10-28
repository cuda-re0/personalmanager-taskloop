import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeAwardedPoints } from '@shared/points/rubric'
import { snapDifficulty } from '@shared/taskRules'
import type {
  Attachment,
  EventResult,
  Evidence,
  Message,
  ReviewVerdict,
  Task,
  TaskDraft
} from '@shared/types/domain'
import type { ChatActions, ChatData, DraftPatch, DraftView, EvidenceView, ReviewView } from './chatTypes'
import { TYPE_DEFAULT_OFFSETS, draftPointsOf, dueHintToLocal, leadLabel } from './chatViewModel'
import {
  FIXTURE_DRAFTS,
  FIXTURE_MESSAGES,
  FIXTURE_TASKS,
  findAttachment,
  makeBulkMessages,
  makeOlderMessages
} from './__fixtures__/messages'

/**
 * 会话区唯一的数据入口。
 *
 * 现在主进程没有注册任何 IPC handler，`window.api.*` 调用会直接 reject，
 * 所以这里全部走本地 fixture；W2 交付后只改这个文件，组件不动。
 */
const PAGE = 20
const THREAD = 'thread-demo'

/**
 * 压测入口：?bulk=1000（03 验收：1000 条滚动 60fps）。仅开发构建生效，
 * 打包后 DEV=false，这个分支不会被打进生产路径。不影响正常视图。
 */
function bulkCount(): number {
  if (typeof window === 'undefined') return 0
  if (!import.meta.env?.DEV) return 0
  const raw = new URLSearchParams(window.location.search).get('bulk')
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 04 §3.3：limit 类只有限时才有 leadHours / overdueDays，取不到 completedAt 就是 null */
function leadHoursOf(task: Task): number | null {
  if (task.type !== 'deadline' || !task.dueAt || !task.completedAt) return null
  const due = Date.parse(task.dueAt)
  const done = Date.parse(task.completedAt)
  if (Number.isNaN(due) || Number.isNaN(done)) return null
  return (due - done) / 3600000
}

/**
 * 逾期天数（只给限时扣分用）。02 只写了「逾期 3 天 → −6」，没写小数日怎么算：
 * 这里按整天计（满 24h 算 1 天），与卡片上「逾期 N 天」的显示同源，不会两处打架。
 */
function overdueDaysOf(leadHours: number | null): number {
  if (leadHours === null || leadHours >= 0) return 0
  return Math.floor(-leadHours / 24)
}

/**
 * 审核卡要显示的两个数（导出只为可测）。
 * 实得分：v0.9 起入参是对象，限时带 leadHours、活动带 result，活动不看完成度。
 * TODO(W6): leadHours 依赖真正的 completedAt（用户点确认/审核通过的时刻），现在读 fixture。
 */
export function scoreOf(
  task: Task,
  verdict: ReviewVerdict,
  result: EventResult | null
): { awarded: number | null; leadLabel: string | null } {
  const leadHours = leadHoursOf(task)
  // 扣分与卡片上的「逾期 N 天」必须同源：算一次，两处都用它
  const overdueDays = overdueDaysOf(leadHours)
  const awarded =
    verdict.verdict === 'pass' || verdict.verdict === 'partial'
      ? computeAwardedPoints({
          type: task.type,
          planned: task.pointsPlanned,
          quality: verdict.quality ?? 'met',
          overdueDays,
          leadHours,
          result
        })
      : null
  return {
    awarded,
    leadLabel: leadHours === null ? null : leadLabel(leadHours, overdueDays) || null
  }
}

function toEvidenceViews(evidence: Evidence[]): EvidenceView[] {
  return evidence.map((item, i) => {
    if (item.kind === 'text') {
      return {
        key: `${item.addedAt}-${i}`,
        kind: 'text' as const,
        text: item.text,
        url: null,
        attachmentKind: null,
        mime: null
      }
    }
    // v0.8：是截图还是 PDF 全看 Attachment.kind
    const file = findAttachment(item.attachmentId)
    return {
      key: `${item.addedAt}-${i}`,
      kind: 'attachment' as const,
      text: null,
      url: file?.url ?? null,
      attachmentKind: file?.kind ?? null,
      mime: file?.mime ?? null
    }
  })
}

/**
 * 草稿 patch 的纯函数部分（导出只为可测）。
 * 类型一变要做两件事：reminderOffsets 换成新类型默认值（复制，不共享同一数组）、
 * 难度不在新类型允许档内就 snapDifficulty 归位（02 §5.2b，平手取低档）。
 */
export function applyDraftPatch(current: TaskDraft, patch: DraftPatch): TaskDraft {
  const offsets =
    patch.type && patch.reminderOffsets === undefined
      ? { reminderOffsets: [...TYPE_DEFAULT_OFFSETS[patch.type]] }
      : {}
  const difficulty =
    patch.type && !patch.difficulty
      ? { difficulty: snapDifficulty(patch.type, current.difficulty) }
      : {}
  const next = { ...current, ...offsets, ...difficulty, ...patch }
  // pointsPlanned 必须与卡面同值（W5 直接写库）。难度或类型一变就按唯一口径重算，
  // 这里不再做 type 判断——draftPointsOf 就是那唯一一处。
  if (next.difficulty !== current.difficulty || next.type !== current.type) {
    next.pointsPlanned = draftPointsOf(next)
  }
  return next
}

export function useChatData(): ChatData {
  const [messages, setMessages] = useState<Message[]>(() => {
    const n = bulkCount()
    return n > 0 ? makeBulkMessages(n) : FIXTURE_MESSAGES
  })
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>(() => {
    const map: Record<string, TaskDraft> = {}
    for (const draft of FIXTURE_DRAFTS) map[draft.localId] = draft
    return map
  })
  const [confirmed, setConfirmed] = useState<Record<string, string>>({})
  const [tasks] = useState<Record<string, Task>>(() => {
    const map: Record<string, Task> = {}
    for (const task of FIXTURE_TASKS) map[task.id] = task
    return map
  })
  const [evidence, setEvidence] = useState<Record<string, Evidence[]>>(() => {
    const map: Record<string, Evidence[]> = {}
    for (const task of FIXTURE_TASKS) map[task.id] = task.evidence
    return map
  })
  // task-report 已经连续 3 次 need_evidence，用来看「直接标记完成（不计分）」出口
  const [needCount] = useState<Record<string, number>>({ 'task-report': 3 })
  // 活动的结果档：初始为空，渲染时先取该条消息自己的 verdict.result，
  // 用户改过才用这里的覆盖值（result 是任务属性，改一处两张卡都变）
  const [results, setResults] = useState<Record<string, EventResult>>({})
  const [sending, setSending] = useState(false)
  const [hasMore, setHasMore] = useState(() => bulkCount() === 0)
  const olderPool = useRef<Message[]>(bulkCount() === 0 ? makeOlderMessages(60) : [])
  const seq = useRef(0)
  const ackTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (ackTimer.current !== null) window.clearTimeout(ackTimer.current)
    }
  }, [])

  const draftViews = useMemo(() => {
    const views: Record<string, DraftView> = {}
    for (const [localId, draft] of Object.entries(drafts)) {
      views[localId] = {
        draft,
        // 分值按 type 分派后重算，不读 draft.pointsPlanned —— 改难度/时长后必须立刻变
        points: draftPointsOf(draft),
        dueLocal: dueHintToLocal(draft.dueHint),
        confirmedTaskId: confirmed[localId] ?? null
      }
    }
    return views
  }, [drafts, confirmed])

  const reviewViews = useMemo(() => {
    const views: Record<string, ReviewView> = {}
    for (const message of messages) {
      if (message.meta.kind !== 'task_review') continue
      const task = tasks[message.meta.taskId]
      if (!task) continue
      const list = evidence[task.id] ?? []
      const isEvent = task.type === 'event'
      const result = isEvent ? (results[task.id] ?? message.meta.verdict.result ?? 'met') : null
      const score = scoreOf(task, message.meta.verdict, result)
      views[message.id] = {
        task: { ...task, evidence: list },
        planned: task.pointsPlanned,
        awarded: score.awarded,
        evidence: toEvidenceViews(list),
        needEvidenceCount: needCount[task.id] ?? 0,
        result,
        leadLabel: score.leadLabel
      }
    }
    return views
  }, [messages, tasks, evidence, needCount, results])

  const patchDraft = useCallback((localId: string, patch: DraftPatch) => {
    setDrafts(prev => {
      const current = prev[localId]
      if (!current) return prev
      return { ...prev, [localId]: applyDraftPatch(current, patch) }
    })
  }, [])

  const setEventResult = useCallback((taskId: string, result: EventResult) => {
    // TODO(W6): 换成 api.task.complete({ id, result })，现在只改本地展示
    setResults(prev => ({ ...prev, [taskId]: result }))
  }, [])

  const confirmDraft = useCallback((localId: string) => {
    // TODO(W5): 换成 api.ai.confirmDraft({ localId })，用返回的 Task.id 回填
    seq.current += 1
    setConfirmed(prev => ({ ...prev, [localId]: `task-local-${seq.current}` }))
  }, [])

  const rejectDraft = useCallback((localId: string) => {
    // TODO(W5): 换成 api.ai.rejectDrafts({ localIds: [localId] })
    setDrafts(prev => {
      const next = { ...prev }
      delete next[localId]
      return next
    })
    setConfirmed(prev => {
      const next = { ...prev }
      delete next[localId]
      return next
    })
  }, [])

  const retry = useCallback((messageId: string) => {
    // TODO(W2): 换成 api.msg.retry({ messageId })
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, status: 'sent' as const } : m)))
  }, [])

  const openTask = useCallback((_taskId: string) => {
    // TODO(W6B): 右栏 ① 滚到该任务并高亮
  }, [])

  const snoozeReminder = useCallback((_reminderId: string) => {
    // TODO(W2): 换成 api.reminder.snooze({ id, minutes: 15 })
  }, [])

  const addEvidence = useCallback((_taskId: string) => {
    // TODO(W5): 证据采集面板 + api.task.addEvidence({ id, evidence })
  }, [])

  const removeEvidence = useCallback((taskId: string, key: string) => {
    // TODO(W5): 换成 api.task.addEvidence 的删除分支
    setEvidence(prev => {
      const list = prev[taskId]
      if (!list) return prev
      const views = toEvidenceViews(list)
      const index = views.findIndex(v => v.key === key)
      if (index < 0) return prev
      return { ...prev, [taskId]: list.filter((_, i) => i !== index) }
    })
  }, [])

  const reReview = useCallback((_taskId: string) => {
    // TODO(W5): 换成 api.ai.review({ taskId })
  }, [])

  const completeTask = useCallback((_taskId: string) => {
    // TODO(W5): 换成 api.task.complete({ id, quality, evidence })
  }, [])

  const continueTask = useCallback((_taskId: string) => {
    // TODO(W5): 收起卡片，任务回到 doing
  }, [])

  const markDoneWithoutPoints = useCallback((_taskId: string) => {
    // TODO(W5): 走到「不计分完成」分支，不入账
  }, [])

  const actions = useMemo<ChatActions>(
    () => ({
      patchDraft,
      confirmDraft,
      rejectDraft,
      retry,
      openTask,
      snoozeReminder,
      addEvidence,
      removeEvidence,
      reReview,
      setEventResult,
      completeTask,
      continueTask,
      markDoneWithoutPoints
    }),
    [
      patchDraft,
      confirmDraft,
      rejectDraft,
      retry,
      openTask,
      snoozeReminder,
      addEvidence,
      removeEvidence,
      reReview,
      setEventResult,
      completeTask,
      continueTask,
      markDoneWithoutPoints
    ]
  )

  const send = useCallback((text: string, attachments: Attachment[]) => {
    const body = text.trim()
    if (!body && attachments.length === 0) return
    seq.current += 1
    const id = `m-local-${seq.current}`
    const userMessage: Message = {
      id,
      threadId: THREAD,
      role: 'user',
      kind: 'text',
      contentMd: body,
      meta: { kind: 'none' },
      linkedTaskId: null,
      status: 'sent',
      attachments,
      createdAt: new Date().toISOString()
    }
    setMessages(prev => [...prev, userMessage])
    setSending(true)
    // TODO(W2): 换成 api.msg.send({ threadId, contentMd, attachmentIds })，assistant 消息走事件流
    ackTimer.current = window.setTimeout(() => {
      setSending(false)
      ackTimer.current = null
    }, 600)
  }, [])

  const loadMore = useCallback(() => {
    const pool = olderPool.current
    if (pool.length === 0) {
      setHasMore(false)
      return
    }
    // TODO(W2): 换成 api.msg.list({ threadId, before: 最早一条的 id, limit: PAGE })
    const chunk = pool.slice(-PAGE)
    olderPool.current = pool.slice(0, pool.length - PAGE)
    setMessages(prev => [...chunk, ...prev])
    setHasMore(olderPool.current.length > 0)
  }, [])

  return {
    messages,
    draftViews,
    reviewViews,
    sending,
    hasMore,
    // 本地 mock 是同步的；W2 换成真接口后这里接 loading 态
    loadingMore: false,
    actions,
    send,
    loadMore
  }
}
