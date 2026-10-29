import { z } from 'zod'
import { ALLOWED_DIFFICULTIES } from '../../shared/taskRules'
import type { TaskType } from '../../shared/types/domain'

/**
 * 模型输出的 schema（03 §4.1 / §4.2）。
 *
 * 这是全系统最要紧的一道闸：模型输出是**唯一**的不可信输入，任何一层都不许绕过 zod。
 * 因此：
 * - 全部 `.strict()`：模型多给的键一律拒（不是剥掉）——多出来的键说明它没按契约说话，
 *   这一次输出不可信，走重试（开工词 §4.4）。
 * - `type × difficulty` 用 `refine` 拒，**不静默归位**：越界说明它判错了类型或判错了难度，
 *   悄悄改成合法值会把错误藏起来（02 §5.2b）。
 * - 报错信息用中文写清"该填什么"：这条 issues 会被拼进重试消息让模型自修（§2.4），
 *   写成英文 zod 默认文案等于放弃了这一次自修机会。
 */

const taskTypeSchema = z.enum(['daily', 'deadline', 'event'])
const difficultySchema = z.enum(['trivial', 'easy', 'medium', 'hard', 'epic'])
const qualitySchema = z.enum(['partial', 'met', 'exceeded'])
const eventResultSchema = z.enum(['exceeded', 'met', 'below'])
const verdictSchema = z.enum(['pass', 'partial', 'fail', 'need_evidence'])

/**
 * `due_hint`：null 或**可被 new Date() 解析的 ISO8601**。
 *
 * 形状必须带年月日与时分。只写 `10-30 18:00` 时 V8 会静默解析成 2001 年（实测，不报错），
 * 而 due_at 同时喂提醒、逾期判定与效率系数三条链路——所以形状先挡一道，再验可解析性。
 */
const dueHintSchema = z
  .string()
  .refine(v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v), {
    message: 'due_hint 必须形如 2026-10-30T15:00:00+08:00（带年月日与时分）'
  })
  .refine(v => !Number.isNaN(new Date(v).getTime()), {
    message: 'due_hint 不是可解析的日期时间'
  })

const dailyTimeSchema = z.string().refine(v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v), {
  message: 'daily_time_hint 必须是 24 小时制的 HH:mm'
})

const stepSchema = z
  .object({
    title: z.string().min(1, '步骤标题不能为空').max(40, '步骤标题最多 40 字'),
    estimate_min: z.number().int().min(1).max(1440).nullable().optional()
  })
  .strict()

const parsedTaskSchema = z
  .object({
    type: taskTypeSchema,
    // 24 字是 prompt 的要求；schema 按落库上限（tasks.title 最多 40 字）兜底。
    // 比 40 更严会让一次"标题长了点"的输出把整批任务判失败，代价不成比例。
    title: z.string().min(1, '标题不能为空').max(40, '标题最多 40 字'),
    detail_md: z.string().max(2000, 'detail_md 最多 2000 字'),
    requires_evidence: z.boolean(),
    difficulty: difficultySchema,
    estimate_min: z.number().int().min(1).max(1440).nullable(),
    due_hint: dueHintSchema.nullable(),
    daily_time_hint: dailyTimeSchema.nullable(),
    tags: z.array(z.string().min(1).max(20)).max(8),
    steps: z.array(stepSchema).max(10),
    missing_info: z.array(z.string().min(1).max(60)).max(5),
    confidence: z.number().min(0).max(1)
  })
  .strict()
  .refine(v => ALLOWED_DIFFICULTIES[v.type].includes(v.difficulty), {
    message:
      '任务类型与难度不匹配：daily 只能是 trivial/easy/medium，deadline 只能是 easy/medium/hard，' +
      'event 只能是 medium/hard/epic。请重新判断类型或难度，不要凑一个合法组合'
  })

export const ParseResultSchema = z
  .object({
    intent: z.enum(['create_task', 'review_task', 'query', 'chat']),
    // 60 字是 prompt 的要求；schema 只挡"整段复述 JSON"这类失控输出，
    // 不想因为回复多了几个字就把一整批有效任务判失败
    reply: z.string().min(1, 'reply 不能为空').max(120, 'reply 最多 120 字'),
    tasks: z.array(parsedTaskSchema).max(3, '一次最多 3 个任务')
  })
  .strict()

export type ParseResult = z.infer<typeof ParseResultSchema>
export type ParsedTask = z.infer<typeof parsedTaskSchema>

/**
 * `review` 的输出 schema（03 §4.2），**按任务类型特化**：
 *
 * - `type='event'`：`result` 必填（三档之一）。活动的得分只看结果，缺了就没法算——
 *   这一条必须是 schema 层面的拒绝，不能等到业务层才发现（03 §4.2 末段）。
 * - 其他类型：`result` 必须是 `null`（契约原话："其他类型必须为 null"）。
 *
 * `quality` 不在这里特化：event 的 `quality` 恒为 `met` 是**归一化规则**（§4.7），
 * 放在 `toVerdict()` 里做，避免模型在 `need_evidence` 时因为填了 null 被判无效输出。
 */
export function reviewResultSchema(type: TaskType) {
  const isEvent = type === 'event'
  return z
    .object({
      verdict: verdictSchema,
      quality: qualitySchema.nullable(),
      // event 的 result 必填；其他类型允许缺省或 null（toVerdict 统一归成 null）
      result: isEvent ? eventResultSchema : z.literal(null).optional(),
      // reason ≤50 字、followup ≤40 字是 03 §4.2 的明文条款，严格按它校验：
      // 这两个字段就是卡面上显示的那两行，超了会被 CSS 截断成"半句话"
      reason: z.string().min(1, 'reason 不能为空').max(50, 'reason 最多 50 字'),
      followup: z.string().max(40, 'followup 最多 40 字').nullable(),
      // 03 §4.2 的输出示例里没有 gaps，但 domain.ts 的 ReviewVerdict 有（partial 时逐条列出）
      gaps: z.array(z.string().min(1).max(40)).max(5).optional()
    })
    .strict()
}

/** 不分类型的宽口径版本（仅测试与文档对照用；实际调用一律走 reviewResultSchema(type)） */
export const ReviewResultSchema = z
  .object({
    verdict: verdictSchema,
    quality: qualitySchema.nullable(),
    // 非 event 允许缺省（模型常常直接不写这个键），统一由 toVerdict 归成 null
    result: eventResultSchema.nullable().optional(),
    reason: z.string().min(1).max(50),
    followup: z.string().max(40).nullable(),
    gaps: z.array(z.string().min(1).max(40)).max(5).optional()
  })
  .strict()

export type ReviewResult = z.infer<typeof ReviewResultSchema>
