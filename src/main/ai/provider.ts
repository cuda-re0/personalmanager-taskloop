import type { ZodType } from 'zod'

/**
 * AI provider 的**唯一**接口（03 §3.0 冻结，签名不许改）。
 *
 * 为什么要有这层：模型调用是最不稳的一段——换供应商、换模型、加中转都会改它。
 * `aiService` 只认这个接口，不 import `glmClient`，所以将来接 harness 时上层一行不改
 * （03 §3.0 的 `proxy` 模式）。
 *
 * `chatJson` 的契约不是"发一次请求"，而是**拿到一个通过 zod 的对象**：
 * 剥围栏、JSON.parse、schema.safeParse、失败重试一次，全部在这一层内完成。
 * 上层拿到 `data` 时不用再校验——校验是接口的一部分，不是调用方的义务。
 */

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatJsonOptions<T> {
  messages: ChatMessage[]
  schema: ZodType<T>
  temperature?: number
  /** 失败后**总共**重试几次。不传按 1 次（03 §3.1 第 2 条：只重试 1 次） */
  maxRetries?: number
  signal?: AbortSignal
}

export interface ChatUsage {
  /** 上游 prompt_tokens */
  in: number
  /** 上游 completion_tokens（**含推理 token**，03 §3.1 第 5 条） */
  out: number
}

export interface ChatJsonResult<T> {
  data: T
  usage: ChatUsage
  latencyMs: number
}

export interface AiProvider {
  chatJson<T>(opts: ChatJsonOptions<T>): Promise<ChatJsonResult<T>>
}

/**
 * 用户/应用主动中断（关窗口、点取消）。
 *
 * 它不是失败：`aiService` 收到这个异常时**不落 error 气泡**，只把占位消息标成未完成
 * （03 §3.1 第 4 条）。用独立类而不是 `DOMException('AbortError')`，是因为主进程与测试
 * 环境里 `DOMException` 不一定可用，而 `instanceof` 判定必须可靠。
 */
export class AiAbortedError extends Error {
  constructor(message = '已取消') {
    super(message)
    this.name = 'AiAbortedError'
  }
}

/** 判断一个异常是不是"主动中断"（跨 realm 也认，`instanceof` 之外再看 name） */
export function isAbortError(e: unknown): boolean {
  if (e instanceof AiAbortedError) return true
  const name = (e as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'AiAbortedError'
}
