import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { computeAwardedPoints } from '@shared/points/rubric'
import type { PointsConfig } from '@shared/points/rubric'
import { snapDifficulty } from '@shared/taskRules'
import type {
  Attachment,
  EventResult,
  Evidence,
  Message,
  ReviewVerdict,
  Task,
  TaskDraft,
  TaskPatch
} from '@shared/types/domain'
import type { ChatActions, ChatData, DraftPatch, DraftView, EvidenceView, ReviewView } from './chatTypes'
import {
  TYPE_DEFAULT_OFFSETS,
  draftPointsOf,
  dueHintToLocal,
  leadLabel,
  normalizeDraft,
  pointsConfigOf
} from './chatViewModel'
import {
  FIXTURE_MESSAGES,
  FIXTURE_TASKS,
  findAttachment,
  makeBulkMessages,
  makeOlderMessages
} from './__fixtures__/messages'

/**
 * 会话区唯一的数据入口。
 *
 * W5 起：挂载时调 `app.getBootstrap` 拿真消息与 settings，成功后**整体替换** fixture
 * （草稿分值按 settings 的完整 PointsConfig 归一，02 §5.2b）。IPC 不可用时才落回
 * fixture（W3 的开发/压测路径）。分页：真消息的向前翻页归 msg 域（W4），本层不越界，
 * 拿到真消息后关闭 loadMore。
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
 * 逾期天数（只给限时扣分用）。02 §5.2：按满 24h 计一天，向下取整——
 * 23h 算 0 天（不扣）、47h 算 1 天。这是渲染层唯一允许出现 Math.floor 的地方，
 * 它不产出积分值，只产出一个天数；卡片上的「逾期 N 天」也用这个数。
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
export function applyDraftPatch(
  current: TaskDraft,
  patch: DraftPatch,
  cfg: PointsConfig
): TaskDraft {
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
    next.pointsPlanned = draftPointsOf(next, cfg)
  }
  return next
}

/**
 * 确认时随 patch 上送的就地编辑值（02 §3.2 `task.promoteDraft` 的 patch）。
 *
 * **没有 type**：TaskPatch 契约里就没有（落库后不可改类型，02 §3.2），落库类型只来自
 * meta_json 里的 draft。卡片上改类型后确认，创建出的仍是原类型——这是契约现状，
 * 已按协作纪律上报架构方（04 §3.2 的草稿卡类型切换与确认链路如何打通需要契约裁决）。
 * dueHint / dailyTimeHint / activeToHint 的形状校验在主进程落库侧兜底。
 */
export function promotePatchOf(draft: TaskDraft): TaskPatch {
  return {
    title: draft.title,
    detailMd: draft.detailMd,
    difficulty: draft.difficulty,
    estimateMin: draft.estimateMin,
    dueAt: draft.type === 'daily' ? null : draft.dueHint,
    dailyTime: draft.type === 'daily' ? draft.dailyTimeHint : null,
    activeTo: draft.type === 'daily' ? draft.activeToHint : null,
    reminderOffsets: [...draft.reminderOffsets],
    tags: [...draft.tags],
    requiresEvidence: draft.requiresEvidence
  }
}

/** 草稿上的幂等标记（主进程写入的额外 JSON 键，TaskDraft 契约冻结不能加字段） */
function promoteMarkerOf(draft: TaskDraft): { promoted?: unknown; promotedTaskId?: unknown } {
  return draft as TaskDraft & { promoted?: unknown; promotedTaskId?: unknown }
}

export function useChatData(): ChatData {
  const [cfg, setCfg] = useState<PointsConfig | null>(null)
  const [messages, setMessages] = useState<Message[]>(() => {
    const n = bulkCount()
    return n > 0 ? makeBulkMessages(n) : FIXTURE_MESSAGES
  })
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({})
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

  // W5 接线①：分值配置换 bootstrap.settings 的完整 PointsConfig（v0.12 第 4 条），
  // 同时把真消息整体换进来（fixture 只在 IPC 不可用时保留）
  useEffect(() => {
    let alive = true
    void window.api.app
      .getBootstrap()
      .then(res => {
        if (!alive) return
        if (!res.ok) {
          console.error('[chat] app.getBootstrap 失败', res.error)
          return
        }
        const nextCfg = pointsConfigOf(res.data.settings)
        setCfg(nextCfg)
        setMessages(res.data.messages)
        setHasMore(false)
        const nextDrafts: Record<string, TaskDraft> = {}
        const promoted: Record<string, string> = {}
        for (const message of res.data.messages) {
          if (message.meta.kind !== 'task_draft') continue
          for (const raw of message.meta.drafts) {
            const draft = normalizeDraft(raw, nextCfg)
            nextDrafts[draft.localId] = draft
            const marker = promoteMarkerOf(draft)
            if (marker.promoted === true && typeof marker.promotedTaskId === 'string') {
              promoted[draft.localId] = marker.promotedTaskId
            }
          }
        }
        setDrafts(nextDrafts)
        setConfirmed(prev => ({ ...prev, ...promoted }))
      })
      .catch((e: unknown) => {
        console.error('[chat] app.getBootstrap 调用失败', e)
      })
    return () => {
      alive = false
    }
  }, [])

  const draftViews = useMemo(() => {
    const views: Record<string, DraftView> = {}
    for (const [localId, draft] of Object.entries(drafts)) {
      views[localId] = {
        draft,
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

  // localId → 所在消息的 id（promoteDraft 必须按消息定位草稿）
  const draftMessageIds = useMemo(() => {
    const map: Record<string, string> = {}
    for (const message of messages) {
      if (message.meta.kind !== 'task_draft') continue
      for (const draft of message.meta.drafts) map[draft.localId] = message.id
    }
    return map
  }, [messages])

  const patchDraft = useCallback(
    (localId: string, patch: DraftPatch) => {
      if (!cfg) return
      setDrafts(prev => {
        const current = prev[localId]
        if (!current) return prev
        return { ...prev, [localId]: applyDraftPatch(current, patch, cfg) }
      })
    },
    [cfg]
  )

  const setEventResult = useCallback((taskId: string, result: EventResult) => {
    // TODO(W6): 换成 api.task.complete({ id, result })，现在只改本地展示
    setResults(prev => ({ ...prev, [taskId]: result }))
  }, [])

  const confirmDraft = useCallback(
    (localId: string) => {
      // W5 接线②：确认 → api.task.promoteDraft，成功后回填已确认态（卡片变灰、显示任务 id）
      const draft = drafts[localId]
      if (!draft) return
      // preload 缺席（纯浏览器开发场景）时退回 W3 的本地标记，不假装调过通道
      if (typeof window.api === 'undefined') {
        seq.current += 1
        setConfirmed(prev => ({ ...prev, [localId]: `task-local-${seq.current}` }))
        return
      }
      const messageId = draftMessageIds[localId]
      if (!messageId) return
      void window.api.task
        .promoteDraft({ messageId, localId, patch: promotePatchOf(draft) })
        .then(res => {
          if (res.ok) {
            setConfirmed(prev => ({ ...prev, [localId]: res.data.id }))
          } else {
            console.error('[chat] 确认草稿失败', res.error)
          }
        })
        .catch((e: unknown) => {
          console.error('[chat] 确认草稿调用失败', e)
        })
    },
    [draftMessageIds, drafts]
  )

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
