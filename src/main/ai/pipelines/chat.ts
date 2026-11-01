import type { Memory, Message, MessageStatus, Persona, PersonaTone } from '../../../shared/types/domain'
import type { AiProvider, ChatMessage } from '../provider'
import { CHAT_RULES } from '../prompts'
import * as chatStateRepo from '../../db/repositories/chatStateRepo'
import * as messageService from '../../services/messageService'
import * as memoryService from '../../services/memoryService'
import * as personaService from '../../services/personaService'
import * as pointsService from '../../services/pointsService'
import * as taskService from '../../services/taskService'
import { buildTodayBrief } from '../../services/chatBrief'
import { runMemoryExtract } from './memory'
import { maybeSummarize } from './summarize'

/**
 * chat 管线（03 §4.3，v0.37）：一条独立于 parse 的纯文本回复链路。
 *
 * 与 parse 的分工是**模式**，不是内容：`mode === 'chat'` 才进这里，主进程不看用户说了什么。
 * 这条管线**不抽任务、不调工具、不查库**——所有数据在主进程拼进 system，模型只负责说话。
 *
 * 失败路径不在这里另起一套：异常照常抛给 `aiService.runTurn` 的 catch，
 * 由它落 error 消息 + `status='failed'`（与 `msg.send` 现有失败一致，03 §4.3.2）。
 */

/** 最近 20 条历史原文（03 §4.3.1） */
export const CHAT_HISTORY_LIMIT = 20
/** 前 12 条记忆（03 §4.3.1 第 2 段） */
export const CHAT_MEMORY_LIMIT = 12
export const CHAT_TEMPERATURE = 0.8
/**
 * 聊天预算 8000（v0.56 从 800 上调）。
 *
 * - 这是**推理 + 正文共享**的总预算：`max_tokens` 卡的是 `reasoning_content + content`，
 *   不是正文字数上限。
 * - `glm-4.7-flashx` 是**强制思考模型**（03 §9.4），每次回复都要先想一段。
 * - 800 时实测推理 794/800、正文 0 字符、`finish_reason=length`——预算定成 800 的那天起，
 *   每一轮聊天都必然失败。实测推理峰值 1214（重 system），8000 留约 6.6 倍余量。
 */
export const CHAT_MAX_TOKENS = 8000

/** 三档语气的固定句，**不要自由发挥**（03 §4.3.1） */
const TONE_LINE: Record<PersonaTone, string> = {
  warm: '说话温和、有耐心，不说教',
  plain: '直接说结论，不铺垫、不客套',
  playful: '轻松一点，可以开玩笑，但不油腻'
}

/** 身份段：段内不换行（03 §4.3.1 第 1 段） */
export function identitySection(persona: Persona): string {
  const parts = [`你是${persona.name}。`]
  const md = persona.personaMd.trim()
  if (md.length > 0) parts.push(md)
  const call = persona.userCall.trim()
  if (call.length > 0) parts.push(`称呼对方为「${call}」。`)
  parts.push(`语气：${TONE_LINE[persona.tone]}`)
  return parts.join('')
}

/** 记忆段：一条都没有时整段省略（03 §4.3.1 第 2 段） */
export function memorySection(memories: readonly Memory[]): string | null {
  if (memories.length === 0) return null
  return ['关于对方，你记得这些：', ...memories.map(item => `- ${item.contentMd}`)].join('\n')
}

/** 历史摘要段：`summary_md` 非空时才有（03 §4.3.1 第 4 段） */
export function summarySection(summaryMd: string): string | null {
  const text = summaryMd.trim()
  return text.length === 0 ? null : `更早的对话摘要：${text}`
}

export interface ChatSystemInput {
  persona: Persona
  memories: readonly Memory[]
  /** `buildTodayBrief()` 的三行 */
  brief: string
  /** `chat_state.summary_md` */
  summaryMd: string
}

/** system 五段拼装，顺序不许变（03 §4.3.1） */
export function buildChatSystem(input: ChatSystemInput): string {
  return [
    identitySection(input.persona),
    memorySection(input.memories),
    input.brief,
    summarySection(input.summaryMd),
    CHAT_RULES.trim()
  ]
    .filter((section): section is string => section !== null && section.length > 0)
    .join('\n\n')
}

export interface ChatRequestInput extends ChatSystemInput {
  /** 历史消息（时间升序，只含 `kind='text'`） */
  recent: readonly Message[]
  /** 本轮用户输入 */
  text: string
}

/**
 * 请求体：`[system] + 最近 20 条原文 + 本轮输入`。
 * 空内容的 assistant 占位（`contentMd === ''`）要排掉，否则模型会看到一条空白的自己。
 */
export function buildChatRequest(input: ChatRequestInput): ChatMessage[] {
  const history: ChatMessage[] = input.recent
    .filter(message => message.contentMd.trim().length > 0)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.contentMd
    }))
  return [
    { role: 'system', content: buildChatSystem(input) },
    ...history,
    { role: 'user', content: input.text }
  ]
}

/** `patchAssistant` 的最小签名（实现在 aiService，广播口径由它统一） */
export type PatchAssistant = (
  id: string,
  patch: {
    contentMd?: string
    status?: MessageStatus
    tokensIn?: number | null
    tokensOut?: number | null
    latencyMs?: number | null
  }
) => void

export interface ChatTurnInput {
  /** 本轮用户消息 id：从历史里排掉，避免同一句进 prompt 两次 */
  userMessageId: string
  assistantMessageId: string
  text: string
  provider: AiProvider
  patchAssistant: PatchAssistant
}

/**
 * 一轮 chat。四步（03 §4.3.1）：取上下文 → `chatText` → 原地 patch → 异步记忆 / 摘要。
 *
 * 第 4 步的两个任务**不 await**：它们失败了也不该让用户看到错误，
 * 更不该把已经到手的回复拖成两段。
 */
export async function runChat(input: ChatTurnInput): Promise<void> {
  const persona = personaService.get()
  const memories = memoryService.list().slice(0, CHAT_MEMORY_LIMIT)
  const brief = buildTodayBrief({
    tasks: taskService.listTasks({ status: ['todo', 'doing', 'pending_review', 'reviewing'] }),
    stat: pointsService.todayStat(),
    balance: pointsService.balance()
  })
  const state = chatStateRepo.get()
  const recent = messageService.recentChatMessages(CHAT_HISTORY_LIMIT, {
    excludeId: input.userMessageId
  })

  const messages = buildChatRequest({
    persona,
    memories,
    brief,
    summaryMd: state.summaryMd,
    recent,
    text: input.text
  })

  const result = await input.provider.chatText({
    messages,
    temperature: CHAT_TEMPERATURE,
    maxTokens: CHAT_MAX_TOKENS
  })

  input.patchAssistant(input.assistantMessageId, {
    contentMd: result.text,
    status: 'sent',
    tokensIn: result.usage.in,
    tokensOut: result.usage.out,
    latencyMs: result.latencyMs
  })

  // 这 12 条真的进了 prompt：加 hits（01 §2.9 的淘汰依据）
  if (memories.length > 0) memoryService.touchHits(memories.map(item => item.id))

  void runMemoryExtract({
    provider: input.provider,
    userText: input.text,
    assistantText: result.text
  })
  void maybeSummarize({ provider: input.provider })
}

/** chat 需要用到的计数器（转出给测试断言，避免测试里重复写死 20 / 12） */
export const CHAT_LIMITS = {
  history: CHAT_HISTORY_LIMIT,
  memory: CHAT_MEMORY_LIMIT,
  temperature: CHAT_TEMPERATURE,
  maxTokens: CHAT_MAX_TOKENS
} as const
