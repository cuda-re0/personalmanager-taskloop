import { z } from 'zod'
import type { AiProvider } from '../provider'
import { SUMMARIZE_SYSTEM } from '../prompts'
import * as chatStateRepo from '../../db/repositories/chatStateRepo'
import * as messageService from '../../services/messageService'

/**
 * 摘要压缩（01 §2.10，v0.37）。
 *
 * 触发条件：`upto_message_id` 之后的**原文** > 40 条。压缩「旧摘要 + 这 40 条里的前 20 条」
 * → 新 `summary_md`（≤600 字），`upto_message_id` 前移到第 20 条。
 *
 * 与记忆提取同一条纪律：**异步、失败静默、下轮再试**。它拖慢的只是后台，
 * 但一旦抛到主链路就会让用户的回复失败——所以 `maybeSummarize` 永不 throw。
 */

export const SUMMARY_TRIGGER = 40
export const SUMMARY_BATCH = 20
export const SUMMARY_MAX_CHARS = 600
export const SUMMARY_TIMEOUT_MS = 30_000

const summarySchema = z.object({ summaryMd: z.string() })

export interface SummarizeInput {
  provider: AiProvider
}

function charCount(text: string): number {
  return Array.from(text).length
}

function clip(text: string): string {
  return charCount(text) <= SUMMARY_MAX_CHARS
    ? text
    : `${Array.from(text).slice(0, SUMMARY_MAX_CHARS - 1).join('')}…`
}

/** 触发条件单独抽出来：测试只喂条数，不需要起库 */
export function shouldSummarize(pendingCount: number): boolean {
  return pendingCount > SUMMARY_TRIGGER
}

export async function maybeSummarize(input: SummarizeInput): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS)
  try {
    const state = chatStateRepo.get()
    const window = messageService.textMessagesAfter(state.uptoMessageId, SUMMARY_TRIGGER + 60)
    if (!shouldSummarize(window.length)) return

    const batch = window.slice(0, SUMMARY_BATCH)
    const transcript = batch
      .map(message => `${message.role === 'assistant' ? '你' : '对方'}：${message.contentMd}`)
      .join('\n')
    const head = state.summaryMd.trim()
    const prompt = head.length === 0 ? transcript : `旧摘要：${head}\n\n新的对话：\n${transcript}`

    const { data } = await input.provider.chatJson({
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: prompt }
      ],
      schema: summarySchema,
      temperature: 0,
      signal: controller.signal
    })

    const summaryMd = clip(data.summaryMd.trim())
    if (summaryMd.length === 0) return
    chatStateRepo.setSummary({ summaryMd, uptoMessageId: batch[batch.length - 1].id })
  } catch (e) {
    // 保留旧摘要、下轮再试；不报错给用户（01 §2.10）
    console.warn('[ai] 摘要压缩失败，下轮再试', e instanceof Error ? e.message : e)
  } finally {
    clearTimeout(timer)
  }
}
