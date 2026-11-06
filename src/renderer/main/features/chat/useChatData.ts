import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BOOTSTRAP_MESSAGE_LIMIT } from '@shared/constants'
import { dueInstant } from '@shared/due'
import { computeAwardedPoints } from '@shared/points/rubric'
import type { PointsConfig } from '@shared/points/rubric'
import { snapDifficulty } from '@shared/taskRules'
import type {
  Attachment,
  ChatMode,
  EventResult,
  Message,
  ReviewVerdict,
  Task,
  TaskCreatePatch,
  TaskDraft
} from '@shared/types/domain'
import type { ChatActions, ChatData, DraftPatch, DraftView, ReviewView } from './chatTypes'
import { createTyper, type Typer } from './typewriter'
import {
  TYPE_DEFAULT_OFFSETS,
  draftPointsOf,
  dueHintToLocal,
  latestNeedEvidenceHint,
  latestReviewGaps,
  leadLabel,
  normalizeDraft,
  pointsConfigOf,
  toEvidenceViews,
  visibleChatMessages
} from './chatViewModel'
import { countNeedEvidence, mergePendingSubmit, runReview, submitForReview } from '../tasks/reviewFlow'
import { FIXTURE_MESSAGES, makeBulkMessages } from './__fixtures__/messages'
import { mergeOlderPage } from './pageModel'

/**
 * 会话区唯一的数据入口。
 *
 * W5 起：挂载时调 `app.getBootstrap` 拿真消息与 settings，成功后**整体替换** fixture
 * （草稿分值按 settings 的完整 PointsConfig 归一，02 §5.2b）。IPC 不可用时才落回
 * fixture（W3 的开发/压测路径）。分页：真消息的向前翻页归 msg 域（W4），本层不越界，
 * 拿到真消息后按首屏条数判定是否还有更早的。
 */
const PAGE = 20

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
  // v0.53：dueAt 可能有 day / month 精度，必须走 dueInstant（裸 Date.parse 会当成 UTC 零点）
  const due = dueInstant(task.dueAt)
  const done = Date.parse(task.completedAt)
  if (due === null || Number.isNaN(done)) return null
  return (due.getTime() - done) / 3600000
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
 * `leadHours` 读任务的 `completedAt`（审核通过那一刻由主进程写入）。
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

/** File → base64（readAsDataURL 的结果截到第一个逗号之后）。上传只走这一条链路，一次一个文件 */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : ''
      const comma = raw.indexOf(',')
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw)
    }
    reader.readAsDataURL(file)
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
 * 确认时随 patch 上送的就地编辑值（02 §3.2 `task.promoteDraft` 的 patch，v0.15 创建侧形状）。
 *
 * **type 恒随卡面**：草稿卡就地改过的类型（applyDraftPatch 已按新类型 snapDifficulty、
 * 重算分值）通过 patch.type 送达主进程，确认按新类型落库（v0.15 打通，此前只来自 meta_json）。
 * 落库后不可改的红线不变——那是 task.update 的 TaskPatch，没有 type。
 * dueHint / dailyTimeHint / activeToHint 的形状校验在主进程落库侧兜底。
 */
export function promotePatchOf(draft: TaskDraft): TaskCreatePatch {
  return {
    type: draft.type,
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
  /**
   * 审核卡的数据源（v0.36）：任务与附件元数据全部从主进程取，不再读 fixture。
   * `tasks` / `evidence` 两个 fixture 派生量已删——真任务的 `task_review` 消息以前在这里
   * 找不到 task，被 `if (!task) continue` 整块跳过，卡片永远不出现。
   */
  const [taskById, setTaskById] = useState<Record<string, Task>>({})
  const [attachmentById, setAttachmentById] = useState<Record<string, Attachment>>({})
  /** 取不到的 id：记下来就**不再重试**，否则每次渲染都重打一次 IPC */
  const missing = useRef<Set<string>>(new Set())
  /**
   * 待提交卡（v0.38）：`pendingList` 是主进程的真值，`submittingTasks` 是提交中的快照。
   * 两者合起来才是要渲染的列表——提交后任务已变 `reviewing`，但从列表里立刻消失会让
   * 用户在「正在审核」的几秒里看不到任何东西。
   */
  const [pendingList, setPendingList] = useState<Task[]>([])
  const [submittingTasks, setSubmittingTasks] = useState<Record<string, Task>>({})
  const [sending, setSending] = useState(false)
  /** 撤回/编辑要填回输入框的原文（v0.48）；null = 没有待填 */
  const [composeText, setComposeText] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(() => bulkCount() === 0)
  const [loadingMore, setLoadingMore] = useState(false)
  const seq = useRef(0)

  /**
   * 模式（v0.37）：`task` 建任务（默认）/ `chat` 闲聊。**不持久化**，重启回 `task`
   * （04 §3.4.1：建任务是主行为，反过来会让用户第二天发一句话就被当闲聊）。
   */
  const [mode, setMode] = useState<ChatMode>('task')

  const toggleMode = useCallback(() => {
    setMode(prev => (prev === 'task' ? 'chat' : 'task'))
  }, [])

  /**
   * 逐字显现的中间态（04 §3.4.2）：`messageId → 当前已显示的前缀`。
   * **只改这里，不动 `messages`**——打完删 key，气泡自然回到完整 `contentMd`。
   */
  const [displayText, setDisplayText] = useState<Record<string, string>>({})
  const typers = useRef<Record<string, Typer>>({})
  const rafId = useRef<number | null>(null)
  /**
   * 本次会话内收到过 `ai.status` 的消息 id：只有它们才打字。
   * `msg.list` / bootstrap 拉回的历史消息不在这个集合里，所以**一律不重放**。
   */
  const liveTurnIds = useRef<Set<string>>(new Set())

  /** 停掉全部打字器（卸载 / 切换会话）。04 §3.4.2：切走再回来**不重放**，直接以完整文本渲染 */
  const stopTyping = useCallback(() => {
    for (const typer of Object.values(typers.current)) typer.stop()
    typers.current = {}
    if (rafId.current !== null) {
      window.cancelAnimationFrame(rafId.current)
      rafId.current = null
    }
    setDisplayText(prev => (Object.keys(prev).length === 0 ? prev : {}))
  }, [])

  /**
   * 一个共享的 rAF 循环推进所有打字器。
   * 不用"每条消息一个 `setInterval`"：多个气泡同时打字时它们的节拍会互相错开，
   * 而且卸载时要逐个清。这里由 `typewriter.tick(now)` 自己按时间算字数。
   */
  const pumpTyping = useCallback(() => {
    if (rafId.current !== null) return
    const step = (): void => {
      const now = performance.now()
      const finished: string[] = []
      for (const [id, typer] of Object.entries(typers.current)) {
        typer.tick(now)
        if (typer.done()) finished.push(id)
      }
      if (finished.length > 0) {
        for (const id of finished) delete typers.current[id]
        setDisplayText(prev => {
          if (finished.every(id => prev[id] === undefined)) return prev
          const next = { ...prev }
          for (const id of finished) delete next[id]
          return next
        })
      }
      rafId.current =
        Object.keys(typers.current).length > 0 ? window.requestAnimationFrame(step) : null
    }
    rafId.current = window.requestAnimationFrame(step)
  }, [])

  const startTyping = useCallback(
    (id: string, text: string) => {
      // 同一条消息只打一次：React 18 的严格模式会重复调用 updater，重复起会从头再来一遍
      if (typers.current[id] !== undefined) return
      typers.current[id] = createTyper({
        text,
        now: () => performance.now(),
        onUpdate: partial => setDisplayText(prev => ({ ...prev, [id]: partial }))
      })
      pumpTyping()
    },
    [pumpTyping]
  )

  /**
   * 拉一个任务进缓存（施工词 33 §2(a) 的三个刷新入口都走它）。
   * `force` 用在卡片动作之后：那时需要的是「动作后的真状态」，不能被 missing 拦住。
   */
  const fetchTask = useCallback(async (taskId: string, force = false): Promise<void> => {
    if (!force && missing.current.has(taskId)) return
    try {
      const res = await window.api.task.get({ id: taskId })
      if (!res.ok) {
        missing.current.add(taskId)
        console.warn('[chat] 任务取不到，审核卡不渲染', taskId, res.error)
        return
      }
      missing.current.delete(taskId)
      // task.get 回 `Task & { subtasks }`，卡片只要 Task 那部分
      const task: Task = res.data
      setTaskById(prev => ({ ...prev, [taskId]: task }))
    } catch (e: unknown) {
      missing.current.add(taskId)
      console.warn('[chat] task.get 调用失败', taskId, e)
    }
  }, [])

  /** 拉一条附件元数据（证据缩略图/角标要 url、kind、mime） */
  const fetchAttachment = useCallback(async (attachmentId: string): Promise<void> => {
    if (missing.current.has(attachmentId)) return
    try {
      const res = await window.api.attachment.get({ id: attachmentId })
      if (!res.ok) {
        missing.current.add(attachmentId)
        console.warn('[chat] 附件取不到，该条证据不渲染', attachmentId, res.error)
        return
      }
      missing.current.delete(attachmentId)
      setAttachmentById(prev => ({ ...prev, [attachmentId]: res.data }))
    } catch (e: unknown) {
      missing.current.add(attachmentId)
      console.warn('[chat] attachment.get 调用失败', attachmentId, e)
    }
  }, [])

  /** 把一批消息里引用的任务全部并发拉进来（去重后一次 Promise.all，不串行） */
  const fetchReviewTasks = useCallback(
    (list: Message[]): void => {
      const ids = new Set<string>()
      for (const message of list) {
        if (message.meta.kind === 'task_review') ids.add(message.meta.taskId)
      }
      if (ids.size === 0) return
      void Promise.all([...ids].map(id => fetchTask(id)))
    },
    [fetchTask]
  )

  /** 拉取待提交列表（v0.38 §7）：状态是唯一真值源，取消/提交/超时后它自然变空 */
  const reloadPending = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.task.list({ status: ['pending_review'] })
      if (!res.ok) {
        console.warn('[chat] 待提交列表取不到', res.error)
        return
      }
      setPendingList(res.data)
    } catch (e: unknown) {
      console.warn('[chat] task.list(pending_review) 调用失败', e)
    }
  }, [])

  /** 首载：与 bootstrap 那次并发，互不依赖 */
  useEffect(() => {
    void reloadPending()
  }, [reloadPending])

  /** 任务进缓存后，把它的证据附件也补齐（同样并发、同样记 missing）；待提交卡同理 */
  useEffect(() => {
    const ids = new Set<string>()
    for (const task of [...Object.values(taskById), ...pendingList]) {
      for (const item of task.evidence) {
        if (item.kind === 'attachment') ids.add(item.attachmentId)
      }
    }
    const pending = [...ids].filter(
      id => attachmentById[id] === undefined && !missing.current.has(id)
    )
    if (pending.length === 0) return
    void Promise.all(pending.map(id => fetchAttachment(id)))
  }, [taskById, pendingList, attachmentById, fetchAttachment])

  useEffect(() => {
    return stopTyping
  }, [stopTyping])

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
        // 条数顶到上限就认为可能还有更早的：允许一次多余的空请求，比漏历史划算
        setHasMore(res.data.messages.length >= BOOTSTRAP_MESSAGE_LIMIT)
        // 刷新时机①：首载拿到 bootstrap 消息之后，把审核消息引用的任务并发拉进来
        fetchReviewTasks(res.data.messages)
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
  }, [fetchReviewTasks])

  /**
   * 会话区的实时化（v0.37）：本单起 `msg.send` 是真调用、**不插乐观消息**，
   * 用户气泡、占位气泡、草稿卡、错误消息全部靠事件进来。
   *
   * 三条订阅：
   * - `message.appended`：按 id 去重后进列表；`task_review` 拉任务、`task_draft` 归一草稿；
   * - `message.patch`：同 id 原地合入（`contentMd` / `status` / `meta`），
   *   若是**本轮** assistant 从空变有内容 → 起打字器（历史消息不在 `liveTurnIds` 里，不重放）；
   * - `ai.status`：thinking 记下这条 id 并置 `sending`，idle 收起（失败也发 idle）。
   *
   * `task.created` / `task.updated` 只用来**原地替换缓存**（不额外打 IPC）。
   */
  useEffect(() => {
    if (typeof window.api === 'undefined') return
    const off = window.api.onEvent(e => {
      if (e.type === 'task.created' || e.type === 'task.updated') {
        setTaskById(prev => (prev[e.task.id] === undefined ? prev : { ...prev, [e.task.id]: e.task }))
        // 待提交列表（v0.38）：进 pending_review 就进列表，离开就出列表，都用载荷，不额打 IPC
        setPendingList(prev => {
          const isPending = e.task.status === 'pending_review'
          const exists = prev.some(t => t.id === e.task.id)
          if (!isPending) return exists ? prev.filter(t => t.id !== e.task.id) : prev
          return exists ? prev.map(t => (t.id === e.task.id ? e.task : t)) : [...prev, e.task]
        })
        return
      }
      if (e.type === 'task.removed') {
        setPendingList(prev => prev.filter(t => t.id !== e.taskId))
        return
      }
      if (e.type === 'ai.status') {
        if (e.phase === 'thinking' && e.messageId !== undefined) {
          liveTurnIds.current.add(e.messageId)
        }
        setSending(e.phase !== 'idle')
        return
      }
      if (e.type === 'message.patch') {
        const messageId = e.messageId
        const patch = e.patch
        const nextContent = patch.contentMd
        let typing: string | null = null
        setMessages(prev =>
          prev.map(message => {
            if (message.id !== messageId) return message
            const wasEmpty = message.contentMd.trim().length === 0
            if (
              message.role === 'assistant' &&
              wasEmpty &&
              typeof nextContent === 'string' &&
              nextContent.trim().length > 0 &&
              liveTurnIds.current.has(messageId)
            ) {
              typing = nextContent
            }
            return { ...message, ...patch }
          })
        )
        if (typing !== null) {
          // 一轮只打一次：从集合里摘掉，后续 patch（例如 meta 更新）不会再触发
          liveTurnIds.current.delete(messageId)
          startTyping(messageId, typing)
        }
        return
      }
      if (e.type !== 'message.appended') return
      const message = e.message
      setMessages(prev => (prev.some(m => m.id === message.id) ? prev : [...prev, message]))
      if (message.meta.kind === 'task_review') {
        // 刷新时机④：新审核消息 → 拉它指向的任务
        void fetchTask(message.meta.taskId)
      }
      if (message.meta.kind === 'task_draft' && cfg !== null) {
        // 建任务模式下主进程补的草稿卡：与 bootstrap 同一套归一（分值按 settings 重算）
        const raw = message.meta.drafts
        setDrafts(prev => {
          const next = { ...prev }
          for (const draft of raw) {
            const normalized = normalizeDraft(draft, cfg)
            next[normalized.localId] = normalized
          }
          return next
        })
      }
    })
    return off
  }, [cfg, fetchTask, startTyping])

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

  /**
   * 审核卡渲染数据（施工词 33 §2(e)）。
   *
   * - 任务与附件都来自主进程缓存；取不到 task 的消息整条不渲染（同 v0.34 行为，但数据源真了）。
   * - `isLatest`：同一任务**最后一条** `task_review` 才有动作按钮。补证据后重审会产生新的
   *   一条消息，旧卡若还能点「重新审核」，一次操作会连发三份 AI 请求、落三条消息。
   * - `needEvidenceCount` 从消息派生（连续 need_evidence 的条数），不再有 fixture 计数。
   */
  const reviewViews = useMemo(() => {
    const views: Record<string, ReviewView> = {}
    const latestByTask = new Map<string, string>()
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const meta = messages[i].meta
      if (meta.kind !== 'task_review') continue
      if (!latestByTask.has(meta.taskId)) latestByTask.set(meta.taskId, messages[i].id)
    }
    for (const message of messages) {
      if (message.meta.kind !== 'task_review') continue
      const task = taskById[message.meta.taskId]
      if (!task) continue
      const isEvent = task.type === 'event'
      const result = isEvent ? (message.meta.verdict.result ?? 'met') : null
      const score = scoreOf(task, message.meta.verdict, result)
      views[message.id] = {
        task,
        planned: task.pointsPlanned,
        awarded: score.awarded,
        evidence: toEvidenceViews(task.evidence, attachmentById),
        needEvidenceCount: countNeedEvidence(messages, task.id),
        result,
        leadLabel: score.leadLabel,
        isLatest: latestByTask.get(message.meta.taskId) === message.id
      }
    }
    return views
  }, [messages, taskById, attachmentById])

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

  /**
   * 重试（v0.50 §2）：只调主进程，**不碰本地状态**。
   *
   * 转圈由主进程 `ai.status`（thinking → idle）驱动，所以不设 `sending`——`sending` 只管
   * 输入框提交，混用会让输入框在重试期间错误地禁用。消息状态由 `message.patch` 推回，
   * 本地预改会和服务端的 `failed` 打架（用户看到的就是"点了没反应还骗人"）。
   */
  const retry = useCallback((messageId: string) => {
    void window.api.msg.retry({ messageId })
      .then(res => {
        if (!res.ok) console.error('[chat] msg.retry 失败', res.error)
      })
      .catch((e: unknown) => console.error('[chat] msg.retry 调用失败', e))
  }, [])

  /**
   * 点提醒行里那条消息（v0.58 §3.7）：右栏的「定位到某条任务」能力并不存在，
   * 所以这里只把主窗叫出来，**不滚动、不高亮**——装作定位成功比不定位更糟。
   */
  const openTask = useCallback((_taskId: string) => {
    // TODO(W6B): 右栏 ① 滚到该任务并高亮（58 只叫出主窗）
    void window.api.app
      .showMain()
      .catch((e: unknown) => console.error('[chat] app.showMain 调用失败', e))
  }, [])

  /** 稍后提醒（v0.58 §3.7）：固定 15 分钟，失败只进日志，不给用户弹任何文案 */
  const snoozeReminder = useCallback((reminderId: string) => {
    void window.api.reminder
      .snooze({ id: reminderId, minutes: 15 })
      .then(res => {
        if (!res.ok) console.error('[chat] reminder.snooze 失败', res.error)
      })
      .catch((e: unknown) => console.error('[chat] reminder.snooze 调用失败', e))
  }, [])

  /** 会话区「知道了」（v0.88）：只翻 acked_at，失败不提示（用户已经点掉了提醒） */
  const ackAlert = useCallback((reminderId: string) => {
    void window.api.alert
      .ack({ sourceId: reminderId })
      .then(res => {
        if (!res.ok) console.error('[chat] alert.ack 失败', res.error)
      })
      .catch((e: unknown) => console.error('[chat] alert.ack 失败', e))
  }, [])

  /**
   * 证据上传（施工词 33 §4）：File → base64 → `attachment.add` → **立即** `task.addEvidence`。
   *
   * 顺序写死：先落附件拿到 `Attachment{ id, kind, url }`，再把它作为证据挂到任务上；
   * 不做「先攒着、提交时一起写」——草稿丢了证据就丢了。mime 原样传 `file.type`（空串也照传），
   * 白名单与体积上限全在主进程，渲染层不重复校验，错误原文直接回给卡片显示。
   */
  const addEvidence = useCallback(async (taskId: string, file: File): Promise<string | null> => {
    try {
      const base64 = await readFileAsBase64(file)
      const added = await window.api.attachment.add({
        name: file.name,
        mime: file.type,
        base64
      })
      if (!added.ok) return added.error.message
      const attached = await window.api.task.addEvidence({
        id: taskId,
        evidence: {
          kind: 'attachment',
          attachmentId: added.data.id,
          addedAt: new Date().toISOString()
        }
      })
      if (!attached.ok) return attached.error.message
      // 缓存就地更新：证据列表要立刻多一条，缩略图也不必再补拉
      setAttachmentById(prev => ({ ...prev, [added.data.id]: added.data }))
      setTaskById(prev => ({ ...prev, [taskId]: attached.data }))
      // 待提交卡（v0.38）读的是 pendingList，同样就地更新，不必等事件回归
      setPendingList(prev =>
        prev.some(t => t.id === taskId)
          ? prev.map(t => (t.id === taskId ? attached.data : t))
          : prev
      )
      return null
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [])

  /**
   * 写一条文字证据（v0.74）：用户说不清「证据为什么不存在」时的那段话。
   *
   * 底层早已支持 `{ kind:'text' }`——`taskService.addEvidence` 会校验非空，
   * `reviewEvidenceOf` 会把它序列化成 `文字证据：…` 送进审核。这里只补一个发请求的口。
   *
   * 三条口径：
   * - 先 `trim`，空串直接返回 `null` 且**不发请求**（省一次往返，也不会落一条空证据）。
   * - 超 200 字按**码点**截断（`Array.from`），不按 `length`——否则会把 emoji 劈成半个。
   * - 成功后与 `addEvidence` 一样就地更新 `taskById` / `pendingList`，不等事件回来。
   */
  const addTextEvidence = useCallback(
    async (taskId: string, text: string): Promise<string | null> => {
      try {
        const body = text.trim()
        if (body.length === 0) return null
        const capped = Array.from(body).slice(0, 200).join('')
        const added = await window.api.task.addEvidence({
          id: taskId,
          evidence: { kind: 'text', text: capped, addedAt: new Date().toISOString() }
        })
        if (!added.ok) return added.error.message
        setTaskById(prev => ({ ...prev, [taskId]: added.data }))
        setPendingList(prev =>
          prev.some(t => t.id === taskId)
            ? prev.map(t => (t.id === taskId ? added.data : t))
            : prev
        )
        return null
      } catch (e: unknown) {
        return e instanceof Error ? e.message : String(e)
      }
    },
    []
  )

  /**
   * 删一条证据（v0.61，只给待提交卡上的 ×）：`task.removeEvidence({ id, index })`。
   *
   * `index` 用证据视图带下来的原始下标，不用视图数组的位置——附件元数据取不到时视图会短一截。
   * 成功后与 `addEvidence` 一样就地更新 `taskById` / `pendingList`，卡片立刻少一格，不等事件回来。
   */
  const removeEvidence = useCallback(
    async (taskId: string, index: number): Promise<string | null> => {
      try {
        const res = await window.api.task.removeEvidence({ id: taskId, index })
        if (!res.ok) return res.error.message
        setTaskById(prev => ({ ...prev, [taskId]: res.data }))
        setPendingList(prev =>
          prev.some(t => t.id === taskId) ? prev.map(t => (t.id === taskId ? res.data : t)) : prev
        )
        return null
      } catch (e: unknown) {
        return e instanceof Error ? e.message : String(e)
      }
    },
    []
  )

  /** 补完证据后重审：分流（pass 计分 / 驳回回 doing 或判 missed）全在 reviewFlow 里 */
  const reReview = useCallback(
    async (taskId: string): Promise<string | null> => {
      const result = await runReview(taskId)
      // 刷新时机③：动作之后重取该任务，卡片按新状态重画
      await fetchTask(taskId, true)
      return result.kind === 'error' ? result.message : null
    },
    [fetchTask]
  )

  /**
   * 防死锁出口（04 §3.3）：连续 3 次 need_evidence 后的「直接标记完成（不计分）」。
   * 不加分、不调 `ai.review`；任务必须还在 `reviewing` 才发完成请求。
   */
  const markDoneWithoutPoints = useCallback(
    async (taskId: string): Promise<string | null> => {
      const current = await window.api.task.get({ id: taskId })
      if (!current.ok) return current.error.message
      if (current.data.status !== 'reviewing') {
        // 已经不在待确认（别人先动过）：只对齐展示，不发完成请求
        const task: Task = current.data
        setTaskById(prev => ({ ...prev, [taskId]: task }))
        return null
      }
      const done = await window.api.task.complete({ id: taskId, noPoints: true })
      if (!done.ok) return done.error.message
      setTaskById(prev => ({ ...prev, [taskId]: done.data.task }))
      return null
    },
    []
  )

  /**
   * 待提交卡的 `[提交]`（v0.38 §5）：两步（`transition` → 送审）在 `reviewFlow.submitForReview`
   * 里，组件不拼流程。提交期间任务留在 `submittingTasks` 里，卡片不会在等 AI 的几秒内消失。
   */
  const submitReview = useCallback(
    async (taskId: string): Promise<string | null> => {
      const snapshot = pendingList.find(t => t.id === taskId)
      if (snapshot) setSubmittingTasks(prev => ({ ...prev, [taskId]: snapshot }))
      try {
        return await submitForReview(taskId)
      } finally {
        setSubmittingTasks(prev => {
          if (prev[taskId] === undefined) return prev
          const next = { ...prev }
          delete next[taskId]
          return next
        })
        void reloadPending()
      }
    },
    [pendingList, reloadPending]
  )

  /** 待提交卡 / 审核卡的 `[取消]`（v0.38 §8）：回进行中，不发分、不调 AI */
  const cancelSubmit = useCallback(async (taskId: string): Promise<string | null> => {
    try {
      const moved = await window.api.task.transition({ id: taskId, to: 'doing' })
      if (!moved.ok) return moved.error.message
      setPendingList(prev => prev.filter(t => t.id !== taskId))
      return null
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e)
    }
  }, [])

  /**
   * 撤回 / 编辑共用的**唯一**实现（v0.48 §5.5 + v0.49 §5.6）：只删一次、只在编辑时回填。
   *
   * `messages` 必须在依赖数组里：回填要读这一轮的原文。不要为了"稳定"改成 ref——
   * ref 拿到的是上一次渲染的文本。
   */
  const removeTurn = useCallback(
    async (messageId: string, fillBack: boolean): Promise<void> => {
      const target = messages.find(m => m.id === messageId)
      const res = await window.api.msg.remove({ messageId })
      if (!res.ok) {
        console.error('[chat] msg.remove 失败', res.error)
        return
      }
      setMessages(prev => prev.filter(m => !res.data.removedIds.includes(m.id)))
      if (fillBack) setComposeText(target ? target.contentMd : '')
    },
    [messages]
  )

  const recallMessage = useCallback(
    (messageId: string) => {
      void removeTurn(messageId, false)
    },
    [removeTurn]
  )

  const editMessage = useCallback(
    (messageId: string) => {
      void removeTurn(messageId, true)
    },
    [removeTurn]
  )

  const actions = useMemo<ChatActions>(
    () => ({
      patchDraft,
      confirmDraft,
      rejectDraft,
      retry,
      editMessage,
      recallMessage,
      openTask,
      snoozeReminder,
      ackAlert,
      addEvidence,
      addTextEvidence,
      removeEvidence,
      reReview,
      markDoneWithoutPoints,
      cancelSubmit,
      submitReview
    }),
    [
      patchDraft,
      confirmDraft,
      rejectDraft,
      retry,
      editMessage,
      recallMessage,
      openTask,
      snoozeReminder,
      ackAlert,
      addEvidence,
      addTextEvidence,
      removeEvidence,
      reReview,
      markDoneWithoutPoints,
      cancelSubmit,
      submitReview
    ]
  )

  /**
   * 真发一条消息（v0.37）：**先上传附件、再发消息**，不插乐观气泡——
   * user / assistant 两条消息都由主进程 `message.appended` 推回来，插一份本地副本
   * 就会变成两个气泡（v0.39 踩过一次）。
   *
   * 返回值只表达「输入框能不能清空」：上传或发送任一步失败都返回 `false`，
   * 由 `ChatInput` 把文字与预览留在框里。成功分支**不复位 `sending`**——
   * 转圈由主进程 `ai.status`（thinking → idle）收口，本地提前复位会让转圈闪一下。
   *
   * 渲染层不做 mime 白名单、不做体积校验：25 MiB 上限与五个 mime 全在
   * `attachmentService`，重复校验只会把可读文案换成通用句。
   */
  const send = useCallback(
    async (text: string, files: File[], nextMode: ChatMode = mode): Promise<boolean> => {
      const body = text.trim()
      if (body.length === 0 && files.length === 0) return false
      setSending(true)
      try {
        const ids: string[] = []
        for (const file of files.slice(0, 4)) {
          const base64 = await readFileAsBase64(file)
          const added = await window.api.attachment.add({
            name: file.name,
            mime: file.type,
            base64
          })
          if (!added.ok) {
            console.error('[chat] attachment.add 失败', added.error)
            setSending(false)
            return false
          }
          ids.push(added.data.id)
        }
        const sent = await window.api.msg.send({
          text: body,
          mode: nextMode,
          ...(ids.length > 0 ? { attachmentIds: ids } : {})
        })
        if (!sent.ok) {
          console.error('[chat] msg.send 失败', sent.error)
          setSending(false)
          return false
        }
        return true
      } catch (e: unknown) {
        console.error('[chat] 发送失败', e)
        setSending(false)
        return false
      }
    },
    [mode]
  )

  const consumeCompose = useCallback(() => setComposeText(null), [])

  const loadMore = useCallback(() => {
    if (loadingMore) return
    const oldest = messages[0]
    if (!oldest) {
      setHasMore(false)
      return
    }
    setLoadingMore(true)
    void window.api.msg
      .list({ before: oldest.id, limit: PAGE })
      .then(res => {
        if (!res.ok) {
          console.error('[chat] 翻页失败', res.error)
          setHasMore(false)
          return
        }
        const next = mergeOlderPage(messages, res.data, PAGE)
        setMessages(next.messages)
        setHasMore(next.hasMore)
      })
      .catch((e: unknown) => {
        console.error('[chat] 翻页失败', e)
        setHasMore(false)
      })
      .finally(() => setLoadingMore(false))
  }, [messages, loadingMore])

  /** 待提交卡要渲染的列表（v0.38）：主进程真值 ∪ 提交中快照，按 `updatedAt` 升序（先进的在上） */
  const pendingSubmit = useMemo(
    () => mergePendingSubmit(pendingList, submittingTasks),
    [pendingList, submittingTasks]
  )

  const submittingIds = useMemo(() => new Set(Object.keys(submittingTasks)), [submittingTasks])

  /**
   * 已有待提交卡占位的任务（v0.41 §2.3）。
   * `pendingSubmit` 本身就是「主进程真值 ∪ 提交中快照」，所以点提交之后的那几秒
   * 任务虽然已变 `reviewing`，这个集合里仍然有它 → 旧审核卡不会闪回来。
   */
  const submitTaskIds = useMemo(
    () => new Set(pendingSubmit.map(task => task.id)),
    [pendingSubmit]
  )

  /**
   * 渲染用消息（v0.39 §3 去重 + v0.41 §2.1 一任务一卡位 + v0.37 逐字显现）：
   * 同一任务只留最新一张审核卡；已经有待提交卡的任务，审核卡整条不渲染。
   * 只过滤渲染数组——`messages` 与 `reviewViews`（按全量算 isLatest）都不动。
   *
   * **顺序写死**：先 `visibleChatMessages` 过滤，再做打字替换。
   * 反过来会让被隐藏的审核卡借着 `displayText` 溜回渲染数组。
   * 替换时**只有正在打字那一条**造新对象，其余原样返回原引用——
   * `MessageItem` 是 `memo`，`{...m}` 会让 20 条全部重渲染并重新测量，打字时整列会抖。
   */
  const visibleMessages = useMemo(() => {
    const base = visibleChatMessages(messages, submitTaskIds)
    if (Object.keys(displayText).length === 0) return base
    return base.map(message =>
      displayText[message.id] === undefined
        ? message
        : { ...message, contentMd: displayText[message.id] }
    )
  }, [messages, submitTaskIds, displayText])

  /** 待提交卡的理由行（v0.41 §2.2）：taskId → 最近一次驳回要求补什么 */
  const needEvidenceHint = useMemo(() => latestNeedEvidenceHint(messages), [messages])

  /** 待提交卡的未完成项清单（v0.42）：taskId → 最近一张审核卡列的 gaps */
  const reviewGaps = useMemo(() => latestReviewGaps(messages), [messages])

  /**
   * 正在跑的那一轮的 user 消息 id（v0.48）：这一条不给「撤回 / 编辑」按钮，
   * 免得用户在 AI 还在想的时候把这一轮抽走。
   *
   * 为什么不用 `sending` 算：`sending` 只管 `msg.send` 的提交，`msg.retry` 不设它；
   * 跑动状态的真值只有消息自己的 `status`。
   */
  const runningUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      if (message.status !== 'pending' && message.status !== 'streaming') continue
      for (let j = i - 1; j >= 0; j -= 1) {
        if (messages[j].role === 'user') return messages[j].id
      }
      return null
    }
    return null
  }, [messages])

  return {
    messages,
    visibleMessages,
    needEvidenceHint,
    reviewGaps,
    draftViews,
    reviewViews,
    pendingSubmit,
    submittingIds,
    attachmentById,
    sending,
    composeText,
    consumeCompose,
    runningUserId,
    hasMore,
    loadingMore,
    actions,
    mode,
    toggleMode,
    send,
    loadMore
  }
}
