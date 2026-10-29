import type { ChatJsonOptions, ChatJsonResult, AiProvider } from '../../src/main/ai/provider'

/**
 * 测试用的假 provider 与假 fetch。
 *
 * 纪律（开工词 §6）：测试**不打真网络**。所以两组假件分工明确：
 * - `fakeFetch`：喂给**真的** `GlmClient`，用来验剥围栏/重试/状态码映射——这些逻辑在客户端里；
 * - `scriptedProvider`：喂给 `aiService`，用来验编排（秒返回、失败收口、状态时序）——
 *   这一层不需要知道 HTTP 长什么样。
 */

/**
 * 响应**工厂**而不是响应对象：`Response` 的 body 只能消费一次，而重试会把同一个响应读两遍
 * （第一次 parse 失败、第二次重试再读），所以每次请求都得构造一个新的。
 */
export type ResponseFactory = () => Response

/** 构造一个 200 响应。`reasoning_content` 故意给一段会污染 JSON 解析的文本（03 §9.1） */
export function chatResponse(
  content: string,
  options: { finish?: string; usage?: { in: number; out: number } } = {}
): ResponseFactory {
  const usage = options.usage ?? { in: 39, out: 172 }
  return () => new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: 'assistant', reasoning_content: '{"intent":"reasoning"}', content },
          finish_reason: options.finish ?? 'stop'
        }
      ],
      usage: { prompt_tokens: usage.in, completion_tokens: usage.out }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

/** 非 2xx 响应工厂 */
export function errorResponse(status: number, body: string): ResponseFactory {
  return () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
}

/** `fetch` 的入参类型：直接用全局 fetch 的签名，避免依赖 DOM lib（本项目 tsconfig 没有 DOM） */
type FetchArgs = Parameters<typeof fetch>

export interface FakeFetch {
  (...args: FetchArgs): Promise<Response>
  calls: number
  /** 每次请求体（解析过的 JSON），用于断言 messages / max_tokens */
  bodies: Array<Record<string, unknown>>
}

/**
 * 按顺序消费 responses；用完后重复最后一项（避免"重试多一次"就把测试炸掉，
 * 计数型断言自己看 `calls`）。
 */
export function fakeFetch(responses: ResponseFactory[]): FakeFetch {
  const bodies: Array<Record<string, unknown>> = []
  const fn = (async (_input: FetchArgs[0], init?: FetchArgs[1]) => {
    fn.calls += 1
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    const index = Math.min(fn.calls - 1, responses.length - 1)
    return responses[index]()
  }) as FakeFetch
  fn.calls = 0
  fn.bodies = bodies
  return fn
}

/** 一个永远不 resolve 的 provider：用来验"send 不等 AI" */
export function hangingProvider(): AiProvider {
  return {
    chatJson: <T>() => new Promise<ChatJsonResult<T>>(() => undefined)
  }
}

export interface ScriptedProvider extends AiProvider {
  calls: number
  options: Array<ChatJsonOptions<never>>
}

/**
 * 按脚本返回的 provider：脚本项是 `(opts) => data`，抛异常就当作 provider 失败。
 * 返回值由调用方保证符合 schema——这一层模拟的是"已经过 zod 的 provider"。
 */
export function scriptedProvider(script: Array<(opts: ChatJsonOptions<never>) => unknown>): ScriptedProvider {
  const provider = {
    calls: 0,
    options: [] as Array<ChatJsonOptions<never>>,
    chatJson: async <T>(opts: ChatJsonOptions<T>): Promise<ChatJsonResult<T>> => {
      const index = Math.min(provider.calls, script.length - 1)
      provider.calls += 1
      provider.options.push(opts as ChatJsonOptions<never>)
      const step = script[index]
      const data = step(opts as ChatJsonOptions<never>)
      return { data: data as T, usage: { in: 42, out: 128 }, latencyMs: 12 }
    }
  }
  return provider as ScriptedProvider
}

/** 轮询等待某个条件成立（异步副作用都发生在微任务/计时器里） */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
