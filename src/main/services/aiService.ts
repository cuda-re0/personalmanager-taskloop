import { z } from 'zod'
import type {
  ChatMode,
  Evidence,
  Message,
  MessageMeta,
  MessageStatus,
  Occurrence,
  ReviewVerdict,
  Task,
  TaskDraft
} from '../../shared/types/domain'
import type { AppErrorCode } from '../../shared/types/ipc'
import { broadcast } from '../bus'
import { tx } from '../db/connection'
import { addDays, todayLocalDay } from '../db/localDay'
import { AppErrorException, appError } from '../db/errors'
import * as occurrenceService from '../db/occurrenceService'
import * as messageRepo from '../db/repositories/messageRepo'
import * as settingRepo from '../db/repositories/settingRepo'
import * as statsRepo from '../db/repositories/statsRepo'
import { GlmClient } from '../ai/glmClient'
import { AI_COPY } from '../ai/copy'
import { readKey, writeKey } from '../ai/config'
import {
  buildParseRequest,
  toTaskDrafts,
  withImageNote,
  type ImagePayload
} from '../ai/pipelines/parse'
import {
  buildReviewRequest,
  hardGateOf,
  toVerdict,
  type ReviewEvidencePart
} from '../ai/pipelines/review'
import { runChat } from '../ai/pipelines/chat'
import { isAbortError, type AiProvider } from '../ai/provider'
import { ParseResultSchema, reviewResultSchema } from '../ai/schema'
import * as attachmentService from './attachmentService'
import * as messageService from './messageService'
import * as pointsService from './pointsService'
import * as taskService from './taskService'

/**
 * aiService —— 六个入口，全部**不 throw 到 IPC 外面**（开工词 §4.8）。
 *
 * 两条硬纪律：
 * 1. `send` 必须秒返回：写 user 消息、写占位 assistant 消息、广播、返回，然后 `void runTurn()`。
 *    渲染层不许 await 到 AI 完成（03 §3.1、02 §3.3）——`glm-5.3-flash` 单次 5.5–29.9s，
 *    await 会让输入框卡到用户以为程序死了。
 * 2. `ai.status` 的 `idle` **失败也要发**，否则 UI 的转圈永远不停。
 *
 * 依赖注入（开工词 §6）：`setProvider()` / `setKeyProbe()` 是模块级 setter，测试用它们换掉真
 * provider 与 Key 探测，**绝不打真网络**。选 setter 而不是构造参数，是因为入口是六个裸函数
 * （IPC 表按 `input => aiService.xxx(input)` 引用），没有对象可注入。
 */

/* ------------------------------------------------------------------ *
 * 注入点（测试专用）
 * ------------------------------------------------------------------ */

let injectedProvider: AiProvider | null = null
let injectedKeyProbe: (() => boolean) | null = null

/** 注入 provider（`null` 恢复生产路径）。测试用，不许在业务代码里调 */
export function setProvider(provider: AiProvider | null): void {
  injectedProvider = provider
}

/** 注入"有没有 Key"的判定（测试用）。不注入时按 `readKey()` 判 */
export function setKeyProbe(probe: (() => boolean) | null): void {
  injectedKeyProbe = probe
}

function isConfigured(): boolean {
  if (injectedKeyProbe !== null) return injectedKeyProbe()
  if (injectedProvider !== null) return true
  return readKey() !== null
}

/** chat 的重参数（03 §4.3.2）：强制思考模型，推理与正文共享 max_tokens。60s 的依据是 8000 预算下实测 23.0~44.8s（重 system），留余量 */
const CHAT_TIMEOUT_MS = 60_000

interface CachedClient {
  /** `apiKey|model|baseUrl|用途` —— 任何一项变了就重建，配置改完下一轮就生效 */
  key: string
  client: AiProvider
}

let parseClient: CachedClient | null = null
let chatClient: CachedClient | null = null

function requireApiKey(): string {
  const apiKey = readKey()
  if (apiKey === null) {
    throw appError('AI_NOT_CONFIGURED', AI_COPY.notConfigured, { retryable: false })
  }
  return apiKey
}

/**
 * 按用途取 client（03 §3.1）：`parse` / `review` 用 `ai.provider.model`（要推理、要识图），
 * `chat` / 记忆 / 摘要用 `ai.chat.model`（纯文本、便宜）。
 *
 * **模块级缓存**：每轮 `new GlmClient` 会让 20 条消息的会话反复重建连接池，
 * 也会让"配置改了什么时候生效"变得不可预期。key 里带上模型名，改了自然重建。
 * 渲染层永远不传模型名——它连这个字段都拿不到。
 */
function parseProvider(): AiProvider {
  if (injectedProvider !== null) return injectedProvider
  const apiKey = requireApiKey()
  const model = settingRepo.get('ai.provider').model
  // v0.59b：地址进了缓存 key，否则用户改完地址下一轮仍拿旧 client，表现为「保存了没生效」
  const baseUrl = settingRepo.get('ai.baseUrl')
  const key = `${apiKey}|${model}|${baseUrl}|parse`
  if (parseClient === null || parseClient.key !== key) {
    parseClient = { key, client: new GlmClient({ apiKey, model, baseUrl }) }
  }
  return parseClient.client
}

function chatProvider(): AiProvider {
  if (injectedProvider !== null) return injectedProvider
  const apiKey = requireApiKey()
  const model = settingRepo.get('ai.chat.model')
  const baseUrl = settingRepo.get('ai.baseUrl')
  const key = `${apiKey}|${model}|${baseUrl}|chat`
  if (chatClient === null || chatClient.key !== key) {
    chatClient = {
      key,
      client: new GlmClient({ apiKey, model, baseUrl, timeoutMs: CHAT_TIMEOUT_MS })
    }
  }
  return chatClient.client
}

function currentProvider(): AiProvider {
  return parseProvider()
}

/**
 * 后台任务（v0.45 汇率评估）的 provider 入口。
 *
 * 为什么单独开一个导出：`fxService` 需要 provider，但它**不能顶层 import 本文件**——
 * `aiService → pointsService → fxService` 已经是一条单向链，再加一条反向 import 就成环，
 * 测试里的模块初始化顺序会变得不可预期。所以由 `fxService` 在函数内部动态拿。
 *
 * 没配 key 时这里会抛 `AI_NOT_CONFIGURED`（与其它调用点一致）；调用方先问 `keyStatus()`
 * 再决定要不要走 AI，避免把"没配 key"当成"评估失败"。
 */
export function backgroundProvider(): AiProvider {
  return chatProvider()
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function broadcastAppended(message: Message): void {
  broadcast({ type: 'message.appended', message })
}

/** 占位消息的更新：库里的埋点字段全写，**广播只带 02 §3.8 允许的三个键** */
function patchAssistant(
  id: string,
  patch: {
    contentMd?: string
    status?: MessageStatus
    meta?: MessageMeta
    tokensIn?: number | null
    tokensOut?: number | null
    latencyMs?: number | null
  }
): void {
  messageService.patchMessage(id, patch)
  const visible: Partial<Message> = {}
  if (patch.contentMd !== undefined) visible.contentMd = patch.contentMd
  if (patch.status !== undefined) visible.status = patch.status
  if (patch.meta !== undefined) visible.meta = patch.meta
  broadcast({ type: 'message.patch', messageId: id, patch: visible })
}

/** 把任意异常收成稳定形状（信封之外的地方也要一个可落库的 error） */
function toAppError(e: unknown): {
  code: AppErrorCode
  message: string
  retryable: boolean
  detail?: string
} {
  if (e instanceof AppErrorException) {
    const err = e.toAppError()
    return { code: err.code, message: err.message, retryable: err.retryable, detail: err.detail }
  }
  return {
    code: 'UNKNOWN',
    message: '未知错误',
    retryable: false,
    detail: e instanceof Error ? e.message : String(e)
  }
}

/**
 * 读附件字节给模型用。**附件读失败不打断这一轮**：用户可能删了一个还挂在消息上的附件，
 * 为它整轮失败、让用户重发一遍文字，代价比"这次少看一张图"大得多。
 */
function readImages(attachmentIds: string[]): ImagePayload[] {
  const images: ImagePayload[] = []
  for (const id of attachmentIds) {
    try {
      const { bytes, mime } = attachmentService.read(id)
      images.push({ mime, bytes })
    } catch (e) {
      console.warn('[ai] 附件读取失败，本轮跳过该附件', id, e instanceof Error ? e.message : e)
    }
  }
  return images
}

/** 这一轮之前的最近消息（升序），供"这个""刚才那个"解析（03 §4.1） */
function contextBefore(userMessageId: string): Message[] {
  const recent = messageService.recentMessages(20)
  const index = recent.findIndex(m => m.id === userMessageId)
  if (index <= 0) return []
  return recent.slice(0, index)
}

/* ------------------------------------------------------------------ *
 * msg.send / msg.retry
 * ------------------------------------------------------------------ */

export interface SendInput {
  text: string
  attachmentIds?: string[]
  /** 省略按 `'chat'`（02 §3.3）：模式只由输入区按钮决定，主进程不看文本内容 */
  mode?: ChatMode
}

export interface SendResult {
  userMessage: Message
  assistantMessageId: string
}

interface TurnInput {
  userMessageId: string
  assistantMessageId: string
  text: string
  attachmentIds: string[]
  mode: ChatMode
}

/**
 * `msg.send`：写 user 消息 → 广播 → 写占位 assistant → 广播 → **立刻返回** → 后台跑一轮。
 */
export function send(input: SendInput): SendResult {
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  // 附件要先截断再判空（v0.49）：顺序反了这里永远拿到空数组，纯图消息会被误判成空消息
  const attachmentIds = (input.attachmentIds ?? []).slice(0, 4)
  if (text.length === 0 && attachmentIds.length === 0) {
    throw appError('INVALID_INPUT', '请求参数格式不正确', {
      detail: 'text 与 attachmentIds 同时为空'
    })
  }

  const created = messageService.appendMessage({
    role: 'user',
    kind: 'text',
    contentMd: text,
    status: 'sent',
    // v0.73：模式落库，渲染层分层直接读标签，不再靠「这一轮有没有卡」猜
    mode: input.mode ?? 'chat'
  })
  if (attachmentIds.length > 0) messageService.attachFiles(created.id, attachmentIds)
  const userMessage = messageService.requireMessage(created.id)
  broadcastAppended(userMessage)

  // 占位消息先落库再返回：渲染层拿到 id 就能立刻画一个"正在想"的气泡
  const assistant = messageService.appendMessage({
    role: 'assistant',
    kind: 'text',
    contentMd: '',
    status: 'pending',
    mode: input.mode ?? 'chat'
  })
  broadcastAppended(assistant)

  void runTurn({
    userMessageId: userMessage.id,
    assistantMessageId: assistant.id,
    text,
    attachmentIds,
    // 守卫已把缺省值落成 'chat'（`chatModeSchema.default('chat')`），这里不再写第二遍默认真值
    mode: input.mode ?? 'chat'
  }).catch(e => {
    // runTurn 内部已收口；这里只兜"连 thinking 都发不出去"的极端情况
    console.error('[ai] 后台轮次异常逃逸', e)
  })

  return { userMessage, assistantMessageId: assistant.id }
}

/**
 * `msg.retry`：找到失败那一轮的用户输入重跑，**同一条 assistant 消息原地 patch**。
 *
 * 入参是 error 消息的 id（04 §3.1 的 `[重试]` 挂在 error 气泡上）。
 * 同样秒返回——重试也是一次 5–30s 的调用，不能让渲染层 await。
 */
export function retry(input: { messageId: string }): void {
  void runTurn(locateTurn(input.messageId)).catch(e => {
    console.error('[ai] 重试轮次异常逃逸', e)
  })
}

/**
 * 撤回范围（v0.48）：起始下标 + 到**下一条 user 之前**。纯函数，不碰 DB（便于测试）。
 *
 * `end` 是**开区间**：下一条 user 的下标，或列表末尾。按下标切片而不是按时间戳——
 * 同一毫秒落库的三条消息按时间比较会漏。`startIndex` 越界返回空范围，不抛。
 */
export function turnRangeOf(
  list: { role: Message['role'] }[],
  startIndex: number
): { start: number; end: number } {
  if (startIndex < 0 || startIndex >= list.length) return { start: startIndex, end: startIndex }
  for (let i = startIndex + 1; i < list.length; i += 1) {
    if (list[i].role === 'user') return { start: startIndex, end: i }
  }
  return { start: startIndex, end: list.length }
}

export interface RemoveTurnResult {
  removedIds: string[]
  removedTaskIds: string[]
}

/**
 * `msg.remove`（v0.48）：撤回 / 编辑的**唯一**后端。
 *
 * 删的是「这一轮」：从这条 user 消息起，到下一个 user 之前（含占位 assistant、错误气泡、
 * 主进程补的回复、草稿卡）。草稿卡上已经确认成任务的那些**软删**（流水与打卡记录保留）——
 * 否则用户撤回了建任务的请求，右栏 ① 里那个任务还杵在那儿。
 *
 * 三条硬约束：
 * - **不广播消息删除事件**：这一单不开 `message.removed`，渲染层按返回值自己过滤。
 * - **不删附件磁盘文件**：文件留在 `userData/attachments/`，W11 统一清理。
 * - **不动 `chat_state`**：摘要里提到已撤内容是接受的陈旧数据。
 *
 * 只接受 user 的 text 消息：撤回别人说的话没有语义；assistant 占位/错误消息由这一轮一起带走。
 */
export function removeTurn(input: { messageId: string }): RemoveTurnResult {
  const list = messageService.listMessages({ limit: 60 })
  const index = list.findIndex(m => m.id === input.messageId)
  if (index === -1) throw appError('NOT_FOUND', '消息不存在', { detail: `id=${input.messageId}` })

  const target = list[index]
  if (target.role !== 'user' || target.kind !== 'text') {
    throw appError('INVALID_INPUT', '请求参数格式不正确', {
      detail: `只能撤回自己发的文字消息，这条是 role=${target.role} kind=${target.kind}`
    })
  }

  const { start, end } = turnRangeOf(list, index)
  const turn = list.slice(start, end)
  const removedIds = turn.map(m => m.id)

  // 草稿卡里已经确认成任务的那些：撤回这一轮就连任务一起软删
  const taskIds = new Set<string>()
  for (const message of turn) {
    if (message.meta.kind !== 'task_draft') continue
    for (const draft of message.meta.drafts) {
      const marker = draft as TaskDraft & { promotedTaskId?: unknown }
      if (typeof marker.promotedTaskId === 'string') taskIds.add(marker.promotedTaskId)
    }
  }

  tx(() => {
    for (const taskId of taskIds) {
      try {
        taskService.removeTask(taskId)
      } catch (e) {
        // 任务已经被删过是正常情况（同一张卡两个任务、其中一个用户先删了）
        console.warn('[ai] 撤回时软删任务失败，继续', taskId, e instanceof Error ? e.message : e)
      }
    }
    messageRepo.removeMany(removedIds)
  })

  for (const taskId of taskIds) broadcast({ type: 'task.removed', taskId })

  return { removedIds, removedTaskIds: [...taskIds] }
}

/**
 * 从一条消息往前找"这一轮的 user 输入 + 它的 assistant 占位"。
 *
 * 为什么靠顺序扫而不是存外键：`messages` 表没有 parent 列（01 §2.5 的封闭列集），
 * 加一列要动 W1 的迁移；而"同一轮的三条消息在会话里连续"是这套流程自己保证的
 * （user → 占位 assistant → 可能的 error）。
 */
function locateTurn(messageId: string): TurnInput {
  const list = messageService.listMessages({ limit: 60 })
  const index = list.findIndex(m => m.id === messageId)
  if (index === -1) throw appError('NOT_FOUND', '消息不存在', { detail: `id=${messageId}` })

  let userIndex = -1
  for (let i = index - 1; i >= 0; i -= 1) {
    if (list[i].role === 'user') {
      userIndex = i
      break
    }
  }
  if (userIndex === -1) {
    throw appError('INVALID_INPUT', '请求参数格式不正确', {
      detail: '这条消息之前没有用户输入，无法重试'
    })
  }
  const userMessage = list[userIndex]
  // v0.73：模式已落库，重试直接读那条 user 消息的标签（当初按什么模式发的就按什么模式重跑）。
  // 老行 mode 为 NULL，沿用历史行为 'task'——反过来当 'chat' 会让「重试失败的建任务」
  // 静默失去草稿卡，比"重试拿到任务回复"更糟。
  const mode: ChatMode = userMessage.mode ?? 'task'

  const existing = list
    .slice(userIndex + 1, index)
    .find(m => m.role === 'assistant' && m.kind !== 'error')
  let assistantMessageId: string
  if (existing) {
    assistantMessageId = existing.id
  } else {
    // 没有占位（例如被外部删掉了行）：补一条，保证结果有地方落
    const created = messageService.appendMessage({
      role: 'assistant',
      kind: 'text',
      contentMd: '',
      status: 'pending',
      mode
    })
    broadcastAppended(created)
    assistantMessageId = created.id
  }

  return {
    userMessageId: userMessage.id,
    assistantMessageId,
    text: userMessage.contentMd,
    attachmentIds: messageService.listAttachments(userMessage.id).map(item => item.id),
    mode
  }
}

/**
 * 草稿卡片落的独立一条消息。
 *
 * **为什么不是"把占位消息 patch 成 task_draft"**：`mappers.mapMessageMeta()` 用
 * `messages.kind` **列**做判别式（default → `{kind:'none'}`），而 `messageRepo.patch`
 * 不支持改 `kind` 列（05 W2 的列集封闭）。也就是说：一条 `kind='text'` 的行永远读不出
 * `meta.kind='task_draft'`，卡片就渲染不出来。
 *
 * 所以一次成功建任务会落两条消息：先是一句回复（占位消息原地 patch），再是一张/一组草稿卡。
 * 这与开工词 §4.8「同一条 assistant 消息原地 patch」不同，是为满足数据契约做的必要偏离，
 * 已列进交付报告。渲染层按 `meta.kind` 分派（04 §3.1），两条消息的顺序天然是"回复在前"。
 */
function appendDraftMessage(drafts: TaskDraft[], mode: ChatMode): void {
  const message = messageService.appendMessage({
    role: 'assistant',
    kind: 'task_draft',
    contentMd: '',
    meta: { kind: 'task_draft', drafts },
    status: 'sent',
    mode
  })
  broadcastAppended(message)
}

/* ------------------------------------------------------------------ *
 * 一轮 AI 的全部副作用
 * ------------------------------------------------------------------ */

async function runTurn(input: TurnInput): Promise<void> {
  broadcast({ type: 'ai.status', phase: 'thinking', messageId: input.assistantMessageId })
  try {
    // 分派只看 `mode`：**不许**在这里或任何上游看用户说了什么（v0.37 §2 第 4 条）
    if (input.mode === 'chat') {
      await runChat({
        userMessageId: input.userMessageId,
        assistantMessageId: input.assistantMessageId,
        text: input.text,
        provider: chatProvider(),
        patchAssistant
      })
      return
    }

    const provider = currentProvider()
    const cfg = pointsService.pointsConfig()
    const request = buildParseRequest({
      text: input.text,
      images: readImages(input.attachmentIds),
      recent: contextBefore(input.userMessageId)
    })

    const { data, usage, latencyMs } = await provider.chatJson({
      messages: request.messages,
      schema: ParseResultSchema,
      // v0.52：建任务的判定规则在 prompt 里写得很死，浅推理就够。实测默认档 82.6s →
      // 7.4s，五类边界输入（复杂日期换算 / 闲聊 / 完成回报 / 信息不足 / 超 10 件）判定一致。
      // 首次没过 schema 时 glmClient 会把重试那次升到 high。
      reasoningEffort: 'low'
    })

    const drafts: TaskDraft[] = toTaskDrafts(data, cfg)

    patchAssistant(input.assistantMessageId, {
      contentMd: withImageNote(data.reply, request.droppedImages),
      status: 'sent',
      tokensIn: usage.in,
      tokensOut: usage.out,
      latencyMs
    })

    // 草稿卡片必须单独一条消息，原因在 `appendDraftMessage` 的注释里（kind 列是判别式，改不了）
    if (drafts.length > 0) appendDraftMessage(drafts, input.mode)
  } catch (e) {
    handleTurnFailure(e, input.assistantMessageId, input.mode)
  } finally {
    // 失败也必须发 idle，否则 UI 的转圈永远不停（开工词 §4.8）
    broadcast({ type: 'ai.status', phase: 'idle', messageId: input.assistantMessageId })
  }
}

/**
 * 一轮失败的收口。
 *
 * 中断（关窗口/取消）**不是失败**：不落 error 气泡，只把占位消息标成未完成——
 * 用户主动取消之后再弹一个红叉，等于我们替他抱怨（03 §3.1 第 4 条）。
 *
 * 注：`MessageStatus` 只有 pending/streaming/sent/failed 四态（domain.ts），
 * 开工词写的 `status: 'aborted'` 在契约里并不存在；不改共享类型的前提下用 `failed`
 * 表达"这一轮没有结果"，且**不落 error 消息**——两处语义就此分开。
 */
function handleTurnFailure(e: unknown, assistantMessageId: string, mode: ChatMode): void {
  if (isAbortError(e)) {
    patchAssistant(assistantMessageId, { status: 'failed' })
    return
  }

  const error = toAppError(e)
  console.error('[ai] 本轮失败', error.code, error.detail ?? error.message)
  try {
    patchAssistant(assistantMessageId, { status: 'failed' })
  } catch (patchError) {
    // 占位消息被删了也要把 error 气泡落下去，这是用户唯一能看到的东西
    console.error('[ai] 占位消息标记失败', patchError)
  }

  const message = messageService.appendMessage({
    role: 'system',
    kind: 'error',
    contentMd: '',
    meta: {
      kind: 'error',
      code: error.code,
      message: error.message,
      retryable: error.retryable
    },
    // 跟随本轮的模式：这一轮是按什么模式发的，错误气泡就属于哪一层
    mode
  })
  broadcastAppended(message)
}

/* ------------------------------------------------------------------ *
 * ai.confirmDraft / ai.rejectDrafts
 * ------------------------------------------------------------------ */

/** 草稿 id 集合差：promote 前后比一次，只有真正新建的 occurrence 才广播（v0.21 收窄口径） */
function newOccurrences(before: Occurrence[], after: Occurrence[]): Occurrence[] {
  const known = new Set(before.map(o => o.id))
  return after.filter(o => !known.has(o.id))
}

/**
 * `ai.confirmDraft`：与 `task.promoteDraft` 等价（02 §3.4），**落库逻辑只有一份**
 * ——直接转调 `taskService.promoteDraft`，这里只补广播。
 *
 * ⚠️ 广播序列与 `registry.ts` 里 `task.promoteDraft` 那一段是同一份行为，目前是两处实现
 * （开工词不许动别人的 row）。**行为必须保持一致**，任何一侧改了都要同步——已列进交付报告的
 * 待合并项。
 */
export function confirmDraft(input: { messageId: string; localId: string }): Task {
  const today = todayLocalDay()
  const rangeTo = addDays(today, 3)
  const before = occurrenceService.listRangeRaw(today, rangeTo)
  const { task, created } = taskService.promoteDraft(input)

  // 幂等早退：本次零写入、零广播（同一 draft 第二次确认）
  if (!created) return task

  // 只广播今天那条：ensureRange 会预生成今天~+3 天，全推会让"今日列表"出现同名多行
  const createdOccurrences = newOccurrences(
    before,
    occurrenceService.listRangeRaw(today, rangeTo)
  ).filter(o => o.day === today)

  broadcast({ type: 'task.created', task })
  for (const sub of taskService.listTasks({ parentId: task.id })) {
    broadcast({ type: 'task.created', task: sub })
  }
  if (createdOccurrences.length > 0) {
    broadcast({ type: 'occurrence.created', occurrences: createdOccurrences })
  }

  const message = messageService.requireMessage(input.messageId)
  broadcast({ type: 'message.patch', messageId: input.messageId, patch: { meta: message.meta } })
  broadcast({ type: 'daystats.changed', day: statsRepo.getDay(today) })
  return task
}

/**
 * `ai.rejectDrafts`：把指定草稿从 `meta.drafts` 里移除。
 *
 * 全丢光时写 `drafts: []`——卡片随之消失（渲染层没有卡片可画，容器为空）。
 * 开工词写的"空了把 `kind` 改成 text"做不到：`kind` 是列、`messageRepo.patch` 不改它，
 * 而 `mapMessageMeta` 以列为判别式（详见 `appendDraftMessage` 的注释）。这条偏离已列进报告。
 */
export function rejectDrafts(input: { messageId: string; localIds: string[] }): void {
  const message = messageService.requireMessage(input.messageId)
  if (message.meta.kind !== 'task_draft') {
    throw appError('INVALID_INPUT', '请求参数格式不正确', {
      detail: `消息 ${input.messageId} 的 meta.kind=${message.meta.kind}，不是 task_draft`
    })
  }

  const drop = new Set(input.localIds)
  const remain = message.meta.drafts.filter(draft => !drop.has(draft.localId))
  if (remain.length === message.meta.drafts.length) {
    throw appError('INVALID_INPUT', '请求参数格式不正确', {
      detail: `消息 ${input.messageId} 里没有这些草稿：${input.localIds.join(',')}`
    })
  }

  const meta: MessageMeta = { kind: 'task_draft', drafts: remain }
  messageService.patchMessage(input.messageId, { meta })
  broadcast({ type: 'message.patch', messageId: input.messageId, patch: { meta } })
}

/* ------------------------------------------------------------------ *
 * ai.review
 * ------------------------------------------------------------------ */

/** 任务上的证据 → 管线要的形状。附件读不到就退化成"类型未知的文件"，不让审核失败 */
function reviewEvidenceOf(evidence: Evidence[]): ReviewEvidencePart[] {
  return evidence.map(item => {
    if (item.kind === 'text') return { kind: 'text', text: item.text }
    try {
      const { bytes, mime } = attachmentService.read(item.attachmentId)
      return mime.startsWith('image/')
        ? { kind: 'image', mime, bytes }
        : { kind: 'file', mime }
    } catch (e) {
      console.warn('[ai] 证据附件读取失败', item.attachmentId, e instanceof Error ? e.message : e)
      return { kind: 'file', mime: 'application/octet-stream' }
    }
  })
}

function appendReviewMessage(task: Task, verdict: ReviewVerdict): void {
  const message = messageService.appendMessage({
    role: 'assistant',
    kind: 'task_review',
    contentMd: verdict.reason,
    linkedTaskId: task.id,
    meta: { kind: 'task_review', taskId: task.id, verdict },
    status: 'sent',
    // 审核卡是任务审核的产物，与用户当时用的输入模式无关，恒为 'task'
    mode: 'task'
  })
  broadcastAppended(message)
}

/**
 * 落审核卡前重读任务状态（v0.41 §4）。
 *
 * `review()` 开头那次 `requireTask` 是**调 AI 之前**的快照；AI 是一个 5–30s 的窗口，
 * 期间任务可能已经离开 `reviewing`（用户点取消、sweeper 10 分钟退回、另一个窗口改走）。
 * 那时再落卡，历史里就多出一张「不该存在的审核卡」——用户看到同一个任务两张卡。
 *
 * 两个落卡点（硬闸门、模型结论）**都必须走这里**，不许只在其中一处加校验。
 * 不落卡时**仍然把 verdict 正常返回**：`ai.review` 的返回类型是冻结契约，不动；
 * 要不要执行流转由渲染层重读后自己判断（reviewFlow §5）。
 */
function appendReviewIfReviewing(task: Task, verdict: ReviewVerdict): void {
  let fresh: Task
  try {
    fresh = taskService.requireTask(task.id)
  } catch (e) {
    // 任务已经被删：没有可落的卡，但这不影响调用方拿到 verdict
    console.warn('[ai] review 结果无法落卡（任务读不到）', task.id, e instanceof Error ? e.message : e)
    return
  }
  if (fresh.status !== 'reviewing') {
    console.warn(
      `[ai] review 结果作废：任务已不在待确认（status=${fresh.status}），不落卡 task=${task.id}`
    )
    return
  }
  appendReviewMessage(task, verdict)
}

/**
 * `ai.review`：读任务 + 证据 → 硬闸门 → 模型 → 落一条 `task_review` 消息 → 返回 verdict。
 *
 * AI 只管判，不管钱：`pass → 入账` 是业务层拿到 verdict 之后的事（03 §4.2 那张表）。
 */
export async function review(input: { taskId: string; userText?: string }): Promise<ReviewVerdict> {
  const task = taskService.requireTask(input.taskId)
  const evidence = reviewEvidenceOf(task.evidence)

  const gate = hardGateOf(task, evidence.length)
  if (gate !== null) {
    // 日志要能看出"这次没发请求"：这行就是判据
    console.log(`[ai] review 硬闸门命中，未发请求 task=${task.id}`)
    // 硬闸门也落卡，所以同样要过状态校验（v0.41 §4：两个落卡点不许只改一处）
    appendReviewIfReviewing(task, gate)
    return gate
  }

  const provider = currentProvider()
  const { data } = await provider.chatJson({
    messages: buildReviewRequest({ task, evidence, userText: input.userText }),
    schema: reviewResultSchema(task.type)
  })

  const verdict = toVerdict(data, task.type)
  appendReviewIfReviewing(task, verdict)
  return verdict
}

/* ------------------------------------------------------------------ *
 * ai.health
 * ------------------------------------------------------------------ */

/** 8×8 纯红 PNG（75 字节）。实测这张图 glm-5.3-flash 能答出"红色"（03 §9.3） */
const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC'

const ProbeSchema = z.object({ color: z.string() }).strict()

let probePromise: Promise<boolean | null> | null = null

/**
 * 多模态探测：**一次真实带图调用**，结果按进程缓存（02 §3.4）。
 *
 * 为什么必须真调：多模态是"计费与能力上最容易踩空"的一项，模型名/版本/端点都可能不同，
 * 不能凭文档假定（03 §6）。探测失败（断网、限流）返回 `null` = 不知道，**不谎报 false**。
 */
async function probeMultimodal(): Promise<boolean | null> {
  try {
    const provider = currentProvider()
    const { data } = await provider.chatJson({
      messages: [
        { role: 'system', content: '你只能输出一个 JSON 对象，不要任何解释。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片主要是什么颜色？只输出 {"color":"颜色"}。' },
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` }
            }
          ]
        }
      ],
      schema: ProbeSchema,
      maxRetries: 0
    })
    return /红|red/i.test(data.color)
  } catch (e) {
    console.warn('[ai] 多模态探测失败', toAppError(e).code)
    return null
  }
}

export interface HealthResult {
  configured: boolean
  model: string
  multimodal: boolean | null
}

/**
 * 只回答「有没有 key」，**不发网络请求、不做多模态探测**（v0.44 设置抽屉）。
 *
 * 判据与 `health().configured` 完全一致（同一个 `isConfigured()`），区别只在于
 * 不像 `health()` 那样 `await` 探测结果：探测那笔钱只该在真要发图时花，
 * 设置里显示一行状态不该等一次网络往返。
 */
export function keyStatus(): { configured: boolean } {
  return { configured: isConfigured() }
}

/**
 * 写 Key（v0.47 设置抽屉）。
 *
 * 副作用只有写文件：不广播、不落库、不发网络请求、不触发任何 AI 管线。
 * `readKey()` 每次都重读文件，所以写完立即生效，不必重启。
 *
 * 两条硬约束：**任何日志、异常 detail、错误 message 里都不许出现 key**（本函数没有
 * 任何 `console.*`）；两句错误 message 原样对应 04 §1.1 的文案表，别改字。
 */
export function setKey(key: string): { configured: boolean } {
  const trimmed = key.trim()
  if (trimmed.length === 0) {
    throw appError('INVALID_INPUT', 'API Key 不能为空')
  }
  // 加密不可用时 writeKey 拒绝落明文并返回 false，此时文件没被写，不需要回滚
  if (!writeKey(trimmed)) {
    throw appError('INVALID_INPUT', 'API Key 保存失败')
  }
  return { configured: isConfigured() }
}

export async function health(): Promise<HealthResult> {
  const model = settingRepo.get('ai.provider').model
  if (!isConfigured()) return { configured: false, model, multimodal: null }

  if (probePromise === null) probePromise = probeMultimodal()
  return { configured: true, model, multimodal: await probePromise }
}

/** 仅供测试：清掉探测缓存与注入 */
export function resetForTest(): void {
  injectedProvider = null
  injectedKeyProbe = null
  probePromise = null
}
