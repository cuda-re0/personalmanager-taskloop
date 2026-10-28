import { z } from 'zod'
import { CH } from '@shared/channels'
import { appError } from '../db/errors'

/**
 * IPC 入参形状校验（05 W2 段交付项 4）。
 *
 * **zod 只拦形状，业务规则仍归 service**——W1 的代码已经会把非法值抛成
 * `INVALID_INPUT`（空标题、未知 setting key、非法日期、非法 repeatRule 等），
 * 这里不要重复实现。校验失败统一 `INVALID_INPUT`「请求参数格式不正确」
 * （04 §1.1 登记的文案）。
 */

export const INVALID_INPUT_MESSAGE = '请求参数格式不正确'

const taskStatusSchema = z.enum(['todo', 'doing', 'reviewing', 'done', 'discarded', 'archived'])
const taskTypeSchema = z.enum(['daily', 'deadline', 'event'])
const difficultySchema = z.enum(['trivial', 'easy', 'medium', 'hard', 'epic'])
const notifyChannelSchema = z.enum(['inapp', 'toast', 'mail', 'webhook'])
/** Priority 是 0|1|2 的字面量联合，schema 用 literal 而不是 min/max，输出类型才能对上 TaskPatch */
const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2)])
const monthSchema = z.number().int().min(1).max(12)
const yearSchema = z.number().int()

/**
 * `TaskPatch` 的形状（domain.ts）。**没有 `type`**：落库后不支持改类型（02 §3.2），
 * 调用方多传 `type` 会被 zod 默认行为剥掉（＝当没有这个字段，不报错）。
 */
const taskPatchSchema = z.object({
  title: z.string().optional(),
  detailMd: z.string().optional(),
  priority: prioritySchema.optional(),
  difficulty: difficultySchema.optional(),
  estimateMin: z.number().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  dailyTime: z.string().nullable().optional(),
  repeatRule: z.string().nullable().optional(),
  activeFrom: z.string().nullable().optional(),
  activeTo: z.string().nullable().optional(),
  reminderOffsets: z.array(z.number()).optional(),
  reminderChannels: z.array(notifyChannelSchema).optional(),
  requiresEvidence: z.boolean().optional(),
  tags: z.array(z.string()).optional()
})

/**
 * `TaskCreatePatch` 的形状（domain.ts，02 §3.2 v0.15）：创建侧 patch，比 TaskPatch 多可选
 * `type`。只给 `task.promoteDraft` 用——draft 尚未落库，确认本质是创建，patch 带 type 按
 * 新类型落库 + 分值按新类型口径重算。`task.update` 仍用 taskPatchSchema（type 被剥掉）。
 */
const taskCreatePatchSchema = taskPatchSchema.extend({
  type: taskTypeSchema.optional()
})

const evidenceSchema = z.union([
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    addedAt: z.string()
  }),
  z.object({
    kind: z.literal('attachment'),
    attachmentId: z.string(),
    addedAt: z.string()
  })
])

const idInput = { id: z.string() }
const monthInput = { year: yearSchema, month: monthSchema }

/**
 * 每条 WIRED 通道一张表：channel → zod schema。
 * 无入参的通道（getBootstrap / quit / balance / occurrence.today…）用 `z.undefined()`——
 * preload 的 `invoke(ch)` 不带 payload，ipcMain 收到的就是 undefined。
 * registry 按属性名引用这份对象（不要抄成 Record 查表：会丢 zod 的入参类型推断）。
 */
export const g = {
  // app
  getBootstrap: z.undefined(),
  setSetting: z.object({ key: z.string().min(1), value: z.unknown() }),
  openExternal: z.object({ url: z.string() }),
  quit: z.undefined(),
  // task
  list: z.object({
    status: z.array(taskStatusSchema).optional(),
    includeSubtasks: z.boolean().optional()
  }),
  get: z.object(idInput),
  promoteDraft: z.object({
    messageId: z.string(),
    localId: z.string(),
    // 创建侧 patch（v0.15）：含可选 type（草稿卡就地改类型 → 确认按新类型落库，02 §3.2）
    patch: taskCreatePatchSchema.optional()
  }),
  update: z.object({ id: z.string(), patch: taskPatchSchema }),
  transition: z.object({
    id: z.string(),
    to: taskStatusSchema,
    reason: z.string().optional()
  }),
  addEvidence: z.object({ id: z.string(), evidence: evidenceSchema }),
  setRequiresEvidence: z.object({ id: z.string(), value: z.boolean() }),
  reorder: z.object({ id: z.string(), beforeId: z.string().nullable() }),
  createManual: z.object({
    type: taskTypeSchema,
    title: z.string(),
    patch: taskPatchSchema.optional()
  }),
  remove: z.object(idInput),
  setReminderOffsets: z.object({
    id: z.string(),
    offsets: z.array(z.number()),
    channels: z.array(notifyChannelSchema).optional()
  }),
  // occurrence
  occurrenceToday: z.undefined(),
  listByRange: z.object({ from: z.string(), to: z.string() }),
  // calendar
  dayIndex: z.object(monthInput),
  dayDetail: z.object({ day: z.string() }),
  // msg
  // limit 必须 ≥1：LIMIT 0 恒空、LIMIT -1 在 SQLite 里返回全表，都不该被当成合法分页
  msgList: z.object({
    before: z.string().optional(),
    limit: z.number().int().min(1).optional()
  }),
  // points
  balance: z.undefined(),
  ledger: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.number().int().min(1).optional()
  }),
  monthStats: z.object(monthInput),
  adjust: z.object({ delta: z.number(), reason: z.string() }),
  preview: z.object({ type: taskTypeSchema, difficulty: difficultySchema }),
  streakPreview: z.object({ current: z.number(), nextDayWillReach: z.number() })
}

/** 校验失败 → AppErrorException(INVALID_INPUT)，由 envelope 转成 ok:false */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw appError('INVALID_INPUT', INVALID_INPUT_MESSAGE, {
    detail: result.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
  })
}

/** 通道名 → schema 的查表（覆盖测试用，保证每条 WIRED 通道都登记了守卫） */
export const guards: Record<string, z.ZodTypeAny> = {
  [CH.app.getBootstrap]: g.getBootstrap,
  [CH.app.setSetting]: g.setSetting,
  [CH.app.openExternal]: g.openExternal,
  [CH.app.quit]: g.quit,
  [CH.task.list]: g.list,
  [CH.task.get]: g.get,
  [CH.task.promoteDraft]: g.promoteDraft,
  [CH.task.update]: g.update,
  [CH.task.transition]: g.transition,
  [CH.task.addEvidence]: g.addEvidence,
  [CH.task.setRequiresEvidence]: g.setRequiresEvidence,
  [CH.task.reorder]: g.reorder,
  [CH.task.createManual]: g.createManual,
  [CH.task.remove]: g.remove,
  [CH.task.setReminderOffsets]: g.setReminderOffsets,
  [CH.occurrence.today]: g.occurrenceToday,
  [CH.occurrence.listByRange]: g.listByRange,
  [CH.calendar.dayIndex]: g.dayIndex,
  [CH.calendar.dayDetail]: g.dayDetail,
  [CH.msg.list]: g.msgList,
  [CH.points.balance]: g.balance,
  [CH.points.ledger]: g.ledger,
  [CH.points.monthStats]: g.monthStats,
  [CH.points.adjust]: g.adjust,
  [CH.points.preview]: g.preview,
  [CH.points.streakPreview]: g.streakPreview
}
