import { duePrecisionOf } from '../../../shared/due'
import { computePlannedPoints } from '../../../shared/points/rubric'
import type { PointsConfig } from '../../../shared/points/rubric'
import type { Message, TaskDraft, TaskType } from '../../../shared/types/domain'
import { newId } from '../../db/ids'
import { AI_COPY } from '../copy'
import { buildParseSystem, parseFewshotMessages } from '../prompts'
import type { ChatContentPart, ChatMessage } from '../provider'
import type { ParseResult } from '../schema'

/**
 * parse 管线：消息（文本 + 图片）→ 多模态 payload → `ParseResult` → `TaskDraft[]`。
 *
 * 分工清楚地划在中间那道 schema 上：**左边全是"怎么问模型"，右边全是"怎么把结果变成业务对象"**。
 * 右侧不读 prompt、不碰网络；左侧不碰积分、不碰 id。所以积分口径的测试不需要起模型，
 * prompt 的调整也不会动到分值。
 */

/** 一次最多 4 张图（03 §5） */
export const MAX_IMAGES = 4
/** 近期上下文条数（03 §4.1：最近 6 条，"这个""刚才那个"要能解析） */
export const CONTEXT_MESSAGES = 6

/**
 * 按类型取默认提醒偏移（01 §2.1.2，与 taskService 的 DEFAULT_OFFSETS 同值）。
 * 这里复制一份是因为 taskService 不导出它，而草稿必须在**确认前**就把偏移显示出来（04 §3.2）。
 */
export const REMINDER_OFFSETS: Record<TaskType, number[]> = {
  deadline: [-1440, -60],
  event: [-10080, -4320, -1440],
  daily: []
}

export interface ImagePayload {
  mime: string
  bytes: Buffer
}

/** 图片 → data URL（03 §9.3：`url` 必须是 `data:<mime>;base64,<…>`） */
export function toDataUrl(image: ImagePayload): string {
  return `data:${image.mime};base64,${image.bytes.toString('base64')}`
}

export interface ParseRequestInput {
  text: string
  images: ImagePayload[]
  /** 最近的消息（升序），只取最后 6 条进上下文 */
  recent?: Message[]
  now?: Date
  /** 只给测试钉时区用 */
  timeZone?: string
}

export interface ParseRequest {
  messages: ChatMessage[]
  /** 超过 4 张被丢掉的图片数（要拼进 reply 说明，不报错） */
  droppedImages: number
  /** 不是图片的附件（PDF 等）数：这类不发给模型，只能在文字里提一句 */
  unsupportedAttachments: number
}

function contextMessages(recent: Message[] | undefined): ChatMessage[] {
  if (!recent || recent.length === 0) return []
  const picked = recent
    .filter(m => (m.role === 'user' || m.role === 'assistant') && m.contentMd.trim().length > 0)
    .slice(-CONTEXT_MESSAGES)
  return picked.map(m => ({ role: m.role, content: m.contentMd }))
}

/**
 * 拼一次 parse 请求。
 *
 * 顺序：system（含【当前时间】）→ fewshot 示例 → 历史上下文 → 本轮 user。
 * 当前时间在 system 末尾，是模型能看到的最早一段；本轮输入在最后，是它最先要处理的。
 */
export function buildParseRequest(input: ParseRequestInput): ParseRequest {
  const images = input.images.filter(i => i.mime.startsWith('image/'))
  const others = input.images.filter(i => !i.mime.startsWith('image/'))
  const used = images.slice(0, MAX_IMAGES)
  const droppedImages = images.length - used.length

  const text = input.text.trim()
  const parts: ChatContentPart[] = []
  parts.push({
    type: 'text',
    text: text.length > 0 ? text : '（用户没有打字，只发了图）'
  })
  for (const image of used) {
    parts.push({ type: 'image_url', image_url: { url: toDataUrl(image) } })
  }
  for (const other of others) {
    parts.push({ type: 'text', text: `（用户还附了一个文件：${other.mime}）` })
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildParseSystem(input.now, input.timeZone) },
    ...parseFewshotMessages(),
    ...contextMessages(input.recent),
    { role: 'user', content: parts }
  ]

  return { messages, droppedImages, unsupportedAttachments: others.length }
}

/**
 * due_hint → TaskDraft.dueHint（v0.53：按精度分流）。
 *
 * `minute` 归一成 UTC；`day` / `month` **原样返回，一个字都不要动**——那个串本身就是要落库的值，
 * `toISOString()` 会把它变成 `2026-11-05T00:00:00.000Z`，等于替用户编了一个零点。
 */
function toDueHint(value: string | null, type: TaskType): string | null {
  // daily 不使用截止时间（01 §2.1.1）：模型偶尔会给 daily 填 due_hint，归一掉
  if (type === 'daily' || value === null) return null
  const precision = duePrecisionOf(value)
  if (precision === 'minute') return new Date(value).toISOString()
  if (precision === 'day' || precision === 'month') return value
  return null
}

/** reply 末尾补一句"多出来的图没看"，不报错（开工词 §4.6） */
export function withImageNote(reply: string, droppedImages: number): string {
  if (droppedImages <= 0) return reply
  return `${reply}${AI_COPY.imagesDropped}`
}

/**
 * `ParseResult` → `TaskDraft[]`（03 §4.1 末段要补齐的三样）。
 *
 * `cfg` 是**必填参数**、不许省：省了就会落回 `DEFAULT_CONFIG`，用户改过
 * `points.difficultyBase` 之后卡面 +35 / 落库 +30 就是这条的必然结果（02 §5.2）。
 */
export function toTaskDrafts(result: ParseResult, cfg: PointsConfig): TaskDraft[] {
  return result.tasks.map(task => ({
    localId: newId(8),
    type: task.type,
    title: task.title,
    detailMd: task.detail_md,
    difficulty: task.difficulty,
    estimateMin: task.estimate_min,
    dueHint: toDueHint(task.due_hint, task.type),
    dailyTimeHint: task.type === 'daily' ? task.daily_time_hint : null,
    // 04 §3.2 的"每日可选结束日期"没有模型来源：留给用户在卡面上填
    activeToHint: null,
    reminderOffsets: [...REMINDER_OFFSETS[task.type]],
    tags: task.tags,
    steps: task.steps.map(step => ({
      localId: newId(8),
      title: step.title,
      estimateMin: step.estimate_min ?? null,
      done: false
    })),
    missingInfo: task.missing_info,
    requiresEvidence: task.requires_evidence,
    confidence: task.confidence,
    // 唯一口径（02 §5.2b）：daily 取 cfg.dailyBase，其余看难度
    pointsPlanned:
      task.type === 'daily' ? cfg.dailyBase : computePlannedPoints(task.difficulty, cfg)
  }))
}
