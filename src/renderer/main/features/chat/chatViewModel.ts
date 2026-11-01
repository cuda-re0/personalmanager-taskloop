import { computePlannedPoints } from '@shared/points/rubric'
import type { PointsConfig } from '@shared/points/rubric'
import type { PublicSettings } from '@shared/types/ipc'
import { snapDifficulty } from '@shared/taskRules'
import type {
  Attachment,
  Difficulty,
  Evidence,
  Message,
  TaskDraft,
  TaskType
} from '@shared/types/domain'
import type { EvidenceView } from './chatTypes'

/** 类型标签。三个词来自 04 §4① 的分组标题，不是新文案。 */
export const TYPE_LABEL: Record<TaskType, string> = {
  daily: '每日',
  deadline: '限时',
  event: '活动'
}

export const TYPE_ORDER: TaskType[] = ['daily', 'deadline', 'event']

/** 难度显示名。04 §3.2（2026-10-28 用户定稿）：不显示英文原值。 */
export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  trivial: '琐事',
  easy: '简单',
  medium: '中等',
  hard: '费劲',
  epic: '大工程'
}

/** 04 §3.2：切换类型时 reminderOffsets 换成该类型默认值 */
export const TYPE_DEFAULT_OFFSETS: Record<TaskType, number[]> = {
  daily: [],
  deadline: [-1440, -60],
  event: [-10080, -4320, -1440]
}

/**
 * bootstrap.settings 的 points.* → rubric 的 PointsConfig（02 §5.2b）。
 *
 * 必须传**完整**配置：不许只传 dailyBase，也不许省略参数落回 DEFAULT_CONFIG——
 * 用户改过 points.difficultyBase 之后，卡面 +35 / 落库 +30 就是省这两步的必然结果。
 * W5 起 useChatData 从 app.getBootstrap 组装（v0.12 第 4 条，原 PENDING_CONFIG 占位已删）。
 */
export function pointsConfigOf(settings: PublicSettings): PointsConfig {
  return {
    difficultyBase: settings['points.difficultyBase'],
    dailyBase: settings['points.dailyBase'],
    streakBonus: settings['points.streakBonus'],
    dailyCap: settings['points.dailyCap']
  }
}

/**
 * pointsPlanned 的唯一口径（02 §5.2b）：daily 取 cfg.dailyBase，deadline / event 看难度。
 *
 * 显示、切类型重算、草稿归一化、W5 写库都必须是这一个数——显示 1 却存 20，每日任务
 * 就会变成每天 20 分。cfg 是必填参数、不许省略：省了会落回 DEFAULT_CONFIG，
 * 用户改过 points.difficultyBase 之后卡面 35 / 落库 30 就是同一类 bug 的另一种形态。
 */
export function draftPointsOf(
  draft: Pick<TaskDraft, 'type' | 'difficulty'>,
  cfg: PointsConfig
): number {
  return draft.type === 'daily' ? cfg.dailyBase : computePlannedPoints(draft.difficulty, cfg)
}

/**
 * 草稿的唯一入口。fixture 与将来从 IPC 拿到的草稿都先过这里：先把难度归位到该类型
 * 允许的档（AI 会给出 daily + hard 这种非法组合，卡面 <select> 匹配不到 option 就是空白，
 * W5 还会照着写库），再按归位后的难度重算分值——两件事必须同序，反过来会按 35 分算完
 * 再改成 medium。
 */
export function normalizeDraft(draft: TaskDraft, cfg: PointsConfig): TaskDraft {
  const difficulty = snapDifficulty(draft.type, draft.difficulty)
  return {
    ...draft,
    difficulty,
    pointsPlanned: draftPointsOf({ type: draft.type, difficulty }, cfg)
  }
}

/** 偏移分钟 → 只读小字。04 §3.2 的例子是「前 1 天 · 前 1 小时」 */
export function offsetLabel(min: number): string {
  const abs = Math.abs(min)
  if (abs % 1440 === 0) return `前 ${abs / 1440} 天`
  if (abs % 60 === 0) return `前 ${abs / 60} 小时`
  return `前 ${abs} 分钟`
}

/**
 * 距截止的显示串（04 §3.3）：`提前 4 天` / `提前 30 小时` / `逾期 3 天`。
 * 只有整数天（≥24h 且能被 24 整除）才说「天」，避免把 30 小时说成 1 天。
 * 不足 1 小时返回空串，卡片整条不显示。
 *
 * 逾期天数必须由调用方传入扣分用的那个数（overdueDaysOf），不许在这里各算各的：
 * 逾期 80 小时若显示「80 小时」、扣分却按 3 天，两处就对不上。
 */
export function leadLabel(leadHours: number, overdueDays = 0): string {
  if (leadHours < 0) {
    if (overdueDays >= 1) return `逾期 ${overdueDays} 天`
    const late = Math.floor(-leadHours)
    return late >= 1 ? `逾期 ${late} 小时` : ''
  }
  const hours = Math.floor(leadHours)
  if (hours < 1) return ''
  if (hours >= 24 && hours % 24 === 0) return `提前 ${hours / 24} 天`
  return `提前 ${hours} 小时`
}

/**
 * 触发点只读串。daily 没有 offsets，走「每日 21:00」这种形式（04 里
 * ReminderPayload.offsetLabel 的示例就是 '每日 21:00'）。
 */
export function reminderSummary(type: TaskType, dailyTime: string | null, offsets: number[]): string {
  if (type === 'daily') return dailyTime ? `每日 ${dailyTime}` : ''
  return offsets.map(offsetLabel).join(' · ')
}

/** mime → 附件角标文字（Attachment 没有文件名字段，只能显示类型） */
export function mimeExt(mime: string | null): string {
  if (!mime) return ''
  const sub = mime.split('/')[1]
  if (!sub) return ''
  return sub.split('+')[0].toLowerCase()
}

/**
 * 消息时间 → 本地 `HH:mm`（v0.49 §5.5）。非法 / 空串 → `''`，调用方据此决定这一格进不进 DOM。
 *
 * **不许**在 UTC 串上切时分（`toISOString()` 的前 16 位是 UTC），那会和用户眼里的时间差 8 小时。
 * 必须走 `Date` 再取本地字段（与 `dueHintToLocal` 同一个理由）。
 */
export function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * dueHint 的合法形状（02 §1）：完整 ISO8601，必须带年月日与时分。
 *
 * 读侧先验形状再交给 Date。V8 会把 '10-30 18:00' 静默当成 2001 年（实测，不报错）：
 * 本地时间 2001-10-30 18:00，toISOString 是 2001-10-30T10:00:00.000Z（UTC+8）。
 * 这个值会一路喂给提醒、逾期判定与效率系数。
 */
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

/**
 * TaskDraft.dueHint（完整 ISO8601 UTC，02 §1）→ datetime-local 值。
 *
 * 必须走 Date 再取本地字段：直接 slice(0,16) 切出来的是 UTC 字符串，
 * 和用户眼里的本地时间差 8 小时。空值/形状不合法/日期不存在一律返回 ''，
 * 不 fallback 到今天，也不把非法值交给 new Date。
 */
export function dueHintToLocal(hint: string | null): string {
  if (!hint) return ''
  if (!ISO_SHAPE.test(hint)) return ''
  const d = new Date(hint)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * datetime-local 值 → TaskDraft.dueHint（完整 ISO8601 UTC）。
 *
 * `new Date('2026-10-30T18:00')` 不带时区后缀，按本地时区解析，这是对的；
 * 只有日期的 `'2026-10-30'` 会被当成 UTC，所以非法值先挡掉再 toISOString。
 */
export function localToDueHint(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString()
}

/**
 * 会话流里**该渲染**的消息（v0.39 §3 去重 + v0.41 §2.1 一任务一卡位）。
 *
 * 两条丢弃规则，按顺序：
 * 1. 该 taskId 已被 `hiddenTaskIds` 命中 → 丢。待提交卡不是消息（它是 `pending_review`
 *    派生的 `SubmitCard`，走 `MessageList` 的 tail），不拦的话同一个任务会同时占两个卡位：
 *    一张旧审核卡 + 一张待提交卡。
 * 2. 同一 taskId 不是**最后一条**审核消息 → 丢（v0.39 原规则，老卡的 `isLatest=false`
 *    只是不显示按钮，卡本身还在）。
 * 非审核消息一律保留。
 *
 * 第二个参数**必填、不给默认值**：给了默认值，下一个人忘了传就静默退回「一任务两卡」。
 * 隐藏是按 `taskId` 判的，不是按消息 id——待提交卡根本没有消息 id。
 *
 * 放在纯函数模块里、入参出参都不可变：`tsconfig.test.json` 没有 DOM，hook 测不了。
 * 只过滤渲染数组，`useChatData.messages` 全量不动（翻页拼接与 `reviewViews.isLatest` 还靠它）。
 */
export function visibleChatMessages(
  messages: Message[],
  hiddenTaskIds: ReadonlySet<string>
): Message[] {
  const latestByTask = new Map<string, string>()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta
    if (meta.kind !== 'task_review') continue
    if (!latestByTask.has(meta.taskId)) latestByTask.set(meta.taskId, messages[i].id)
  }
  return messages.filter(message => {
    const meta = message.meta
    if (meta.kind !== 'task_review') return true
    if (hiddenTaskIds.has(meta.taskId)) return false
    return latestByTask.get(meta.taskId) === message.id
  })
}

/**
 * 每个任务「最近一次驳回要求补什么」（v0.41 §2.2）：`taskId → followup`。
 *
 * 待提交卡要显示的理由行就取这里。只认**最新那条**审核消息：
 * - 倒序扫，每个 taskId 第一次遇到的就是最新的，看完就 `seen` 掉；
 * - 最新的不是 `need_evidence`（pass / partial / fail），或 `followup` 为空 → **不记这个 key**，
 *   不记空串。调用方按「有没有 key」决定渲不渲染那一行，空串会让它渲染一个空 `<p>`。
 */
export function latestNeedEvidenceHint(messages: Message[]): Record<string, string> {
  const hints: Record<string, string> = {}
  const seen = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta
    if (meta.kind !== 'task_review') continue
    if (seen.has(meta.taskId)) continue
    seen.add(meta.taskId)
    if (meta.verdict.verdict !== 'need_evidence') continue
    const followup = meta.verdict.followup
    if (typeof followup === 'string' && followup.trim().length > 0) hints[meta.taskId] = followup
  }
  return hints
}

/**
 * 每个任务「最近一次审核列出的未完成项」（v0.42）：`taskId → verdict.gaps`。
 *
 * 待提交卡要显示的那张列表就取这里。与 `latestNeedEvidenceHint` 同一个扫法、同一条时间线：
 * - 倒序扫，每个 taskId 第一次遇到的就是最新那张卡，看完就 `seen` 掉（旧的 gaps 不参与）；
 * - 只看 `gaps.length > 0`，不看 verdict 类型——`partial` 自然命中，`need_evidence` 的 gaps
 *   一般为空自然不命中；
 * - 最新的那张 gaps 为空 → **不记这个 key**（不是记空数组），调用方拿 `?? []`。
 *   于是"旧卡有、新卡没有"时结果是没有 key，而不是把旧卡的清单顶上来。
 * - 不合并历史、不去重、不截断、不排序：顺序就是 AI 给的原顺序。
 */
export function latestReviewGaps(messages: Message[]): Record<string, string[]> {
  const gaps: Record<string, string[]> = {}
  const seen = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta
    if (meta.kind !== 'task_review') continue
    if (seen.has(meta.taskId)) continue
    seen.add(meta.taskId)
    if (meta.verdict.gaps.length > 0) gaps[meta.taskId] = meta.verdict.gaps
  }
  return gaps
}

/**
 * Evidence[] → 卡片渲染数据（v0.36）。
 *
 * 放在这个纯函数模块里而不是 `useChatData`：它要能被 node 环境的测试直接引入
 * （`tsconfig.test.json` 只带 ES2022，没有 DOM——一个 `window` 就把整个模块拖红）。
 * 附件元数据从外部缓存取；**取不到的条目直接跳过**，不造占位符、不写「附件失效」。
 */
export function toEvidenceViews(
  evidence: Evidence[],
  attachments: Record<string, Attachment>
): EvidenceView[] {
  const views: EvidenceView[] = []
  evidence.forEach((item, i) => {
    if (item.kind === 'text') {
      views.push({
        key: `${item.addedAt}-${i}`,
        kind: 'text',
        text: item.text,
        url: null,
        attachmentKind: null,
        mime: null
      })
      return
    }
    const file = attachments[item.attachmentId]
    if (!file) return
    // v0.8：是截图还是 PDF 全看 Attachment.kind
    views.push({
      key: `${item.addedAt}-${i}`,
      kind: 'attachment',
      text: null,
      url: file.url,
      attachmentKind: file.kind,
      mime: file.mime
    })
  })
  return views
}
