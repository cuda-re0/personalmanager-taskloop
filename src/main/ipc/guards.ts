import { z } from 'zod'
import { CH } from '@shared/channels'
import type { EventResult } from '@shared/types/domain'
import type { HudSize } from '@shared/types/ipc'
import { appError } from '../db/errors'
import { clampOpacity, clampSize } from '../services/hudService'

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
/** 悬浮形态（02 §3.0 `HudMode` v0.30）：球 / 面板两值，与契约同步；旧串由 hudService 回落 ball */
const hudModeSchema = z.enum(['ball', 'panel'])
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
const qualitySchema = z.enum(['partial', 'met', 'exceeded'])

/**
 * 活动结果档（domain.ts 的 `EventResult`，02 §5）。zod 要的是运行期数组、无法从类型派生，
 * 所以在这里复写一份——`satisfies` 保证每个值都是合法的 `EventResult`（拼错即编译失败，
 * 例如写成 `'exceed'` 就不会被静默放行）。domain.ts 增删档位时两处同改。
 */
const EVENT_RESULTS = ['exceeded', 'met', 'below'] as const satisfies readonly EventResult[]
const eventResultSchema = z.enum(EVENT_RESULTS)

/**
 * `task.complete` 的入参（02 §3.2 的 `CompleteTaskInput` 可辨识联合）。
 *
 * 两个分支互斥：给了 `quality` 就是计分，`noPoints:true` 就是不计分。
 * **两个都给必须拒**——zod 的 object 会剥掉不认识的键，若直接用 union，
 * `{quality, noPoints:true}` 会悄悄落到第二个分支、quality 被丢掉，等于默认不计分。
 * 所以先用 preprocess 把它变成非法值，让两个分支都匹配不上，统一报「请求参数格式不正确」。
 */
const completeTaskSchema = z.preprocess(
  raw => {
    if (raw !== null && typeof raw === 'object') {
      const record = raw as Record<string, unknown>
      if (record.noPoints === true && record.quality !== undefined) return undefined
    }
    return raw
  },
  z.union([
    z.object({
      id: z.string(),
      quality: qualitySchema,
      // 仅 event 生效（v0.19）：deadline / daily 传了由 service 忽略，不报错
      result: eventResultSchema.optional(),
      evidence: z.array(evidenceSchema).optional(),
      noPoints: z.literal(false).optional()
    }),
    z.object({
      id: z.string(),
      noPoints: z.literal(true),
      evidence: z.array(evidenceSchema).optional()
    })
  ])
)

/**
 * `app.setSetting`（02 §3.0 的封闭 key 集合）。
 *
 * 通用形状是 `{key, value:unknown}`——未知 key 由 `settingRepo.set` 抛 `INVALID_INPUT`，这里不复写。
 * 只有 v0.30 的三个 hud 项需要在这一层收口（04 §5.4 / 施工词 28 §4）：
 * - `hud.opacity`：必须是有限数，**夹到 0.3–1**（滑杆之外的脏值不该让渲染层炸掉）；
 * - `hud.size`：`null` 或 `{width,height}` 有限数，夹到 280×320–720×900；
 * - `hud.background`：`null` 或 `#rrggbb`（合成 `rgba()` 时不再猜格式）。
 *
 * 校验用 `superRefine` **不用 transform 里 parse**：zod v4 会原样抛出 transform 内的
 * `ZodError`（实测），那样 `safeParse` 就变成 throw，信封拿不到 `ok:false`。
 */
const HUD_BG_PATTERN = /^#[0-9a-fA-F]{6}$/

const setSettingSchema = z
  .object({ key: z.string().min(1), value: z.unknown() })
  .superRefine((input, ctx) => {
    const fail = (message: string): void => {
      ctx.addIssue({ code: 'custom', path: ['value'], message })
    }
    if (input.key === 'hud.opacity') {
      if (typeof input.value !== 'number' || !Number.isFinite(input.value)) fail('透明度必须是数字')
      return
    }
    if (input.key === 'hud.size') {
      if (input.value === null) return
      const size = input.value as { width?: unknown; height?: unknown }
      if (
        typeof size !== 'object' ||
        size === null ||
        typeof size.width !== 'number' ||
        typeof size.height !== 'number' ||
        !Number.isFinite(size.width) ||
        !Number.isFinite(size.height)
      ) {
        fail('面板尺寸必须是 {width,height}')
      }
      return
    }
    if (input.key === 'hud.background') {
      if (input.value === null) return
      if (typeof input.value !== 'string' || !HUD_BG_PATTERN.test(input.value)) {
        fail('背景色必须是 #rrggbb')
      }
    }
  })
  .transform(input => {
    if (input.key === 'hud.opacity') {
      return { ...input, value: clampOpacity(input.value as number) }
    }
    if (input.key === 'hud.size' && input.value !== null) {
      return { ...input, value: clampSize(input.value as HudSize) }
    }
    return input
  })

/**
 * 每条 WIRED 通道一张表：channel → zod schema。
 * 无入参的通道（getBootstrap / quit / balance / occurrence.today…）用 `z.undefined()`——
 * preload 的 `invoke(ch)` 不带 payload，ipcMain 收到的就是 undefined。
 * registry 按属性名引用这份对象（不要抄成 Record 查表：会丢 zod 的入参类型推断）。
 */
export const g = {
  // app
  getBootstrap: z.undefined(),
  setSetting: setSettingSchema,
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
  // task.complete（W6）
  taskComplete: completeTaskSchema,
  // task.undo（v0.19）：与 task.get 同款 idInput
  taskUndo: z.object(idInput),
  // occurrence.complete / undo / skip（W6）
  occurrenceComplete: z.object(idInput),
  occurrenceUndo: z.object(idInput),
  occurrenceSkip: z.object({ id: z.string(), note: z.string().optional() }),
  // calendar
  dayIndex: z.object(monthInput),
  dayDetail: z.object({ day: z.string() }),
  // msg
  // limit 必须 ≥1：LIMIT 0 恒空、LIMIT -1 在 SQLite 里返回全表，都不该被当成合法分页
  msgList: z.object({
    before: z.string().optional(),
    limit: z.number().int().min(1).optional()
  }),
  // msg.send / msg.retry（W4）：单条输入上限 4000 字、附件最多 4 张（03 §5）
  msgSend: z.object({
    text: z.string().min(1).max(4000),
    attachmentIds: z.array(z.string()).max(4).optional()
  }),
  msgRetry: z.object({ messageId: z.string().min(1) }),
  // ai.*（W4，02 §3.4）
  aiConfirmDraft: z.object({ messageId: z.string().min(1), localId: z.string().min(1) }),
  aiRejectDrafts: z.object({
    messageId: z.string().min(1),
    localIds: z.array(z.string().min(1)).min(1)
  }),
  aiReview: z.object({ taskId: z.string().min(1), userText: z.string().max(2000).optional() }),
  // 无入参：preload 的 invoke(ch) 不带 payload，收到的是 undefined
  aiHealth: z.object({}).optional(),
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
  streakPreview: z.object({ current: z.number(), nextDayWillReach: z.number() }),
  // hud（W9 · v0.30）：坐标必须有限值——NaN/Infinity 会让 setBounds 抛出，且会写进 hud.position
  hudSetMode: z.object({ mode: hudModeSchema }),
  hudMoveTo: z.object({ x: z.number().finite(), y: z.number().finite() }),
  hudSetVisible: z.object({ visible: z.boolean() }),
  hudGetState: z.undefined()
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
  [CH.task.complete]: g.taskComplete,
  [CH.task.undo]: g.taskUndo,
  [CH.occurrence.today]: g.occurrenceToday,
  [CH.occurrence.listByRange]: g.listByRange,
  [CH.occurrence.complete]: g.occurrenceComplete,
  [CH.occurrence.undo]: g.occurrenceUndo,
  [CH.occurrence.skip]: g.occurrenceSkip,
  [CH.calendar.dayIndex]: g.dayIndex,
  [CH.calendar.dayDetail]: g.dayDetail,
  [CH.msg.list]: g.msgList,
  [CH.msg.send]: g.msgSend,
  [CH.msg.retry]: g.msgRetry,
  [CH.ai.confirmDraft]: g.aiConfirmDraft,
  [CH.ai.rejectDrafts]: g.aiRejectDrafts,
  [CH.ai.review]: g.aiReview,
  [CH.ai.health]: g.aiHealth,
  [CH.points.balance]: g.balance,
  [CH.points.ledger]: g.ledger,
  [CH.points.monthStats]: g.monthStats,
  [CH.points.adjust]: g.adjust,
  [CH.points.preview]: g.preview,
  [CH.points.streakPreview]: g.streakPreview,
  [CH.hud.setMode]: g.hudSetMode,
  [CH.hud.moveTo]: g.hudMoveTo,
  [CH.hud.setVisible]: g.hudSetVisible,
  [CH.hud.getState]: g.hudGetState
}
