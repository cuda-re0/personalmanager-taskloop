import { z } from 'zod'
import type { AiProvider } from '../provider'
import { MEMORY_SYSTEM } from '../prompts'
import * as memoryService from '../../services/memoryService'

/**
 * 记忆自动提取（03 §4.4，v0.37）。
 *
 * **在 chat 轮次成功之后异步跑**：不阻塞回复、失败静默（只 `console.warn`，
 * 不落 error 消息、不弹任何东西）。这里做完三件事就返回：
 * 拿到 `{ memories: [...] }`、截到 2 条、逐条交给 `memoryService.addAuto`。
 *
 * 不做的事（03 §4.4 末段）：不更新已有记忆（只增）、不删、不判断「这条是不是过时了」。
 */

export const MEMORY_MAX_ITEMS = 2
export const MEMORY_EXTRACT_TIMEOUT_MS = 15_000

const memoryResultSchema = z.object({
  memories: z
    .array(
      z.object({
        contentMd: z.string(),
        kind: z.enum(['profile', 'preference', 'fact'])
      })
    )
    .default([])
})

export interface MemoryExtractInput {
  provider: AiProvider
  /** 本轮用户文本 */
  userText: string
  /** 本轮 assistant 回复 */
  assistantText: string
}

function buildPrompt(input: MemoryExtractInput, existing: readonly string[]): string {
  const known =
    existing.length === 0
      ? '（还没有任何记忆）'
      : ['已有记忆（不要重复提取）：', ...existing.map(text => `- ${text}`)].join('\n')
  return [
    known,
    `本轮用户说：${input.userText}`,
    `本轮你回复：${input.assistantText}`
  ].join('\n\n')
}

/**
 * 跑一次提取。**永不 throw**：调用方是 `void runMemoryExtract(...)`，
 * 任何异常在这里被吞掉并写一行日志。
 */
export async function runMemoryExtract(input: MemoryExtractInput): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MEMORY_EXTRACT_TIMEOUT_MS)
  try {
    const existing = memoryService.list().map(item => item.contentMd)
    const { data } = await input.provider.chatJson({
      messages: [
        { role: 'system', content: MEMORY_SYSTEM },
        { role: 'user', content: buildPrompt(input, existing) }
      ],
      schema: memoryResultSchema,
      temperature: 0,
      signal: controller.signal
    })
    for (const item of data.memories.slice(0, MEMORY_MAX_ITEMS)) {
      memoryService.addAuto({ contentMd: item.contentMd, kind: item.kind })
    }
  } catch (e) {
    // 静默：用户在聊天，不该因为「后台记不住」看到一条红字
    console.warn('[ai] 记忆提取失败，本轮跳过', e instanceof Error ? e.message : e)
  } finally {
    clearTimeout(timer)
  }
}
