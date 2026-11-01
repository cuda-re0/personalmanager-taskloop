import type { ZodType } from 'zod'
import { appError } from '../db/errors'
import { AI_COPY } from './copy'
import type {
  AiProvider,
  ChatJsonOptions,
  ChatJsonResult,
  ChatMessage,
  ChatTextOptions,
  ChatTextResult
} from './provider'
import { AiAbortedError } from './provider'

/**
 * 智谱 GLM 的 `AiProvider` 实现（03 §3.1）。
 *
 * 所有实测口径都落在这个文件里（03 §9）：
 * - `glm-5.3-flash` 是**推理模型**：响应里 `reasoning_content` 与 `content` 并列，
 *   **只有 `content` 是答案**，`reasoning_content` 一律丢弃（§9.1）。
 * - `max_tokens` 一律 10000（v0.51 从 2048 上调）。给小了推理会把预算吃光，
 *   `content` 返回空串且 `finish_reason: "length"`；这种截断重试也是同样的截断，
 *   所以**不重试**，直接 `AI_PARSE_FAILED`（§9.1、开工词 §2.2）。
 * - `response_format: json_object` 可用，但仍保留剥围栏兜底（§9.2）。
 * - 图片走 `image_url` + `data:<mime>;base64,…`（§9.3）。
 * - 超时 180s（v0.51 从 60s 上调，和 max_tokens 是配套的：10000 token 按实测
 *   约 75 token/s 要 130s+），`AbortController` 可控（§3.1 第 4 条）。
 * - `tokens_out` 用上游 `completion_tokens`（含 `reasoning_tokens`），不许自己数
 *   `content.length`（§3.1 第 5 条）。
 *
 * 这个文件只负责"发一次能拿到合法对象的请求"，不碰数据库、不碰消息表。
 */

export const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
export const AI_TIMEOUT_MS = 180_000
export const AI_MAX_TOKENS = 10_000
/** 重试时把上一次的坏输出拼回去，截断到这个长度足够模型自修，也不会把 prompt 撑爆 */
const ECHO_LIMIT = 2000
/** 错误 detail 里上游响应的截断长度（开工词 §4.9 同一口径：不打印完整响应体） */
const BODY_LIMIT = 200

export interface GlmClientOptions {
  apiKey: string
  model: string
  baseUrl?: string
  timeoutMs?: number
  maxTokens?: number
  /** 仅测试注入；生产走全局 fetch */
  fetchImpl?: typeof fetch
}

interface RequestOutcome {
  content: string
  finishReason: string
  usage: { in: number; out: number }
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 剥 markdown 围栏（开工词 §2.4 第 2 步）。
 *
 * 只认 ```` ```json ```` 与 ```` ``` ```` 两种开栅栏，别的形态原样返回——猜错形态比不剥更危险。
 * `response_format: json_object` 生效时本来不会带围栏，但 prompt 改坏或换模型时会退化成
 * 带围栏的文本（03 §9.2），这段就是那个兜底。
 */
export function stripFence(raw: string): string {
  let text = raw.trim()
  if (!text.startsWith('```')) return text

  const firstBreak = text.indexOf('\n')
  // ```json{"a":1}``` 这种单行形态：没有换行时人工切掉前缀
  if (firstBreak === -1) {
    return text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim()
  }
  text = text.slice(firstBreak + 1)

  const trimmedEnd = text.trimEnd()
  if (trimmedEnd.endsWith('```')) {
    text = trimmedEnd.slice(0, trimmedEnd.lastIndexOf('```'))
  }
  return text.trim()
}

/** 一次输出 → 合法对象。失败返回原因（会被拼进重试消息） */
function parseOnce<T>(
  content: string,
  schema: ZodType<T>
): { ok: true; data: T } | { ok: false; reason: string } {
  const stripped = stripFence(content)
  if (stripped.length === 0) return { ok: false, reason: '输出为空' }

  let raw: unknown
  try {
    raw = JSON.parse(stripped)
  } catch (e) {
    return { ok: false, reason: `不是合法 JSON（${e instanceof Error ? e.message : String(e)}）` }
  }

  const result = schema.safeParse(raw)
  if (result.success) return { ok: true, data: result.data }

  const issues = result.error.issues
    .map(issue => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
    .join('; ')
  return { ok: false, reason: `字段不符合要求（${issues}）` }
}

/** 任何要写进日志/detail 的文本都先过这里：绝不出现 key，连前 6 位都不行（03 §9.7） */
export function scrub(text: string, apiKey: string): string {
  if (!apiKey) return text
  let out = text.split(apiKey).join('[key]')
  const head = apiKey.slice(0, 6)
  if (head.length === 6) out = out.split(head).join('[key]')
  return out
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/* ------------------------------------------------------------------ *
 * 客户端
 * ------------------------------------------------------------------ */

export class GlmClient implements AiProvider {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxTokens: number
  private readonly fetchImpl: typeof fetch

  constructor(options: GlmClientOptions) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.baseUrl = options.baseUrl ?? GLM_BASE_URL
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS
    this.maxTokens = options.maxTokens ?? AI_MAX_TOKENS
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
  }

  async chatJson<T>(opts: ChatJsonOptions<T>): Promise<ChatJsonResult<T>> {
    const started = Date.now()
    // 开工词 §2.4 末句：总共只重试 1 次，不是"parse 一次 + zod 一次"各一次
    const maxRetries = opts.maxRetries ?? 1

    let messages: ChatMessage[] = [...opts.messages]
    let lastReason = '输出不符合要求'
    let lastContent = ''

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      // v0.52：首次按调用方给的推理档跑；没过 schema 要重试时升到 high——同样的档位
      // 再来一次，多半还是同样的错。调用方没指定档位（review 等）时两次都不发该字段。
      const outcome = await this.request(messages, {
        ...opts,
        reasoningEffort:
          opts.reasoningEffort === undefined
            ? undefined
            : attempt === 0
              ? opts.reasoningEffort
              : 'high'
      })
      lastContent = outcome.content

      // 截断 → 直接失败，不重试：同样的 token 预算会得到同样的截断（开工词 §2.2）
      if (outcome.finishReason === 'length') {
        throw appError('AI_PARSE_FAILED', AI_COPY.parseFailed, {
          retryable: true,
          detail: `finish_reason=length（content ${outcome.content.length} 字符，out=${outcome.usage.out} tokens）`
        })
      }

      const parsed = parseOnce(outcome.content, opts.schema)
      if (parsed.ok) {
        return {
          data: parsed.data,
          usage: outcome.usage,
          latencyMs: Date.now() - started
        }
      }
      lastReason = parsed.reason

      if (attempt < maxRetries) {
        // 自修：把坏输出与具体 issues 一起回给模型。只说"再试一次"它是不会改的
        messages = [
          ...messages,
          { role: 'assistant', content: truncate(outcome.content, ECHO_LIMIT) },
          {
            role: 'user',
            content:
              `上一次的输出没有通过校验：${lastReason}\n` +
              '请重新只输出一个 JSON 对象，不要 markdown 围栏，不要解释，不要补充任何额外字段。'
          }
        ]
      }
    }

    throw appError('AI_PARSE_FAILED', AI_COPY.parseFailed, {
      retryable: true,
      detail: scrub(
        `${lastReason}（已重试 ${maxRetries} 次；末次输出 ${truncate(lastContent, 80)}）`,
        this.apiKey
      )
    })
  }

  /**
   * `chatText`：纯文本回复（03 §3.1 v0.37、v0.56）。
   *
   * 与 `chatJson` 只差三处：body 不带 `response_format`、结果不解析 JSON、
   * 只做「剥围栏 → trim → 空串报 AI_PARSE_FAILED」。**`chatJson` 的实现一个字没动。**
   *
   * v0.56：空正文**原样重发一次**（最多 2 次请求）。空正文不是格式错，没有 issues 可回授，
   * 改 prompt 只会引入不确定性；`finish_reason === 'length'` 不重试（同样的预算得到同样的截断，
   * 与 `chatJson` §2.2 同一原则）。两次的 tokens 相加落库，`latencyMs` 从第一次请求发起算起。
   */
  async chatText(opts: ChatTextOptions): Promise<ChatTextResult> {
    const started = Date.now()
    const maxAttempts = 2

    let usage = { in: 0, out: 0 }
    let lastFinish = 'unknown'
    let lastLength = 0
    let attempted = 0

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const outcome = await this.requestText(opts.messages, opts)
      attempted += 1
      // 账单口径：两次的真实消耗都要算进去
      usage = { in: usage.in + outcome.usage.in, out: usage.out + outcome.usage.out }
      lastFinish = outcome.finishReason
      lastLength = outcome.content.length

      const text = stripFence(outcome.content).trim()
      if (text.length > 0) {
        return { text, usage, latencyMs: Date.now() - started }
      }
      // 截断：同样的预算重试还是截断，直接失败
      if (outcome.finishReason === 'length') break
    }

    throw appError('AI_PARSE_FAILED', AI_COPY.parseFailed, {
      retryable: true,
      detail: `chatText 输出为空（finish_reason=${lastFinish}，正文 ${lastLength} 字符，已重试 ${attempted - 1} 次）`
    })
  }

  /** 一次 HTTP 往返（纯文本）。超时/鉴权/状态码映射与 `request` 同一套口径 */
  private async requestText(
    messages: ChatMessage[],
    opts: ChatTextOptions
  ): Promise<RequestOutcome> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    const onOuterAbort = (): void => controller.abort()
    if (opts.signal?.aborted) controller.abort()
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? this.maxTokens
    }

    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (e) {
      if (opts.signal?.aborted && !timedOut) throw new AiAbortedError()
      if (timedOut) {
        throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, {
          retryable: true,
          detail: `请求超时（${this.timeoutMs}ms）`
        })
      }
      throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, {
        retryable: true,
        detail: scrub(e instanceof Error ? e.message : String(e), this.apiKey)
      })
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }

    if (!response.ok) throw await this.httpError(response)

    let payload: unknown
    try {
      payload = await response.json()
    } catch (e) {
      throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, {
        retryable: true,
        detail: `响应体不是 JSON（${e instanceof Error ? e.message : String(e)}）`
      })
    }

    return this.readOutcome(payload, true)
  }

  /** 一次 HTTP 往返。鉴权、超时、状态码映射都在这里，失败一律抛 AppErrorException */
  private async request<T>(
    messages: ChatMessage[],
    opts: ChatJsonOptions<T>
  ): Promise<RequestOutcome> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)
    // 用户取消（关窗口/点取消）→ 立即中断，不等到超时
    const onOuterAbort = (): void => controller.abort()
    if (opts.signal?.aborted) controller.abort()
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

    const body = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: this.maxTokens,
      response_format: { type: 'json_object' },
      // v0.52：不传就不发这个字段，保持上游默认（max）。`glm-5.3-flash` 不支持 disabled
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {})
    }

    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (e) {
      if (opts.signal?.aborted && !timedOut) throw new AiAbortedError()
      if (timedOut) {
        throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, {
          retryable: true,
          detail: `请求超时（${this.timeoutMs}ms）`
        })
      }
      throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, {
        retryable: true,
        detail: scrub(e instanceof Error ? e.message : String(e), this.apiKey)
      })
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onOuterAbort)
    }

    if (!response.ok) throw await this.httpError(response)

    let payload: unknown
    try {
      payload = await response.json()
    } catch (e) {
      throw appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, {
        retryable: true,
        detail: `响应体不是 JSON（${e instanceof Error ? e.message : String(e)}）`
      })
    }

    return this.readOutcome(payload)
  }

  /** 上游状态码 → 业务错误码（开工词 §4.2） */
  private async httpError(response: Response): Promise<Error> {
    let detail = `HTTP ${response.status}`
    try {
      const text = await response.text()
      // 只留前 200 字符：完整响应体又长又可能带内部信息
      detail = scrub(`${detail} ${truncate(text, BODY_LIMIT)}`, this.apiKey)
    } catch {
      // 读不到 body 就算了，状态码已经够定位
    }

    const status = response.status
    if (status === 401 || status === 403) {
      return appError('AI_NOT_CONFIGURED', AI_COPY.notConfigured, { retryable: false, detail })
    }
    if (status === 429) {
      return appError('AI_RATE_LIMITED', AI_COPY.rateLimited, { retryable: true, detail })
    }
    if (status >= 500) {
      return appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, { retryable: true, detail })
    }
    // 其余 4xx（400 参数错、404 模型名错）：重试没有意义
    return appError('AI_UPSTREAM_ERROR', AI_COPY.upstream, { retryable: false, detail })
  }

  /**
   * 从响应体里取 `content` / `finish_reason` / `usage`。`reasoning_content` 读都不读。
   *
   * `allowEmpty`：只有 `requestText`（`chatText`）传 true——它要自己拿空正文去做"重试一次"的判定，
   * 不能被这里抢先抛错。`chatJson` 那条路径照旧（默认 false，行为一个字不变）。
   */
  private readOutcome(payload: unknown, allowEmpty = false): RequestOutcome {
    const root = payload as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    const choice = root?.choices?.[0]
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : ''
    const finishReason =
      typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'unknown'
    const usage = {
      in: typeof root?.usage?.prompt_tokens === 'number' ? root.usage.prompt_tokens : 0,
      // 含推理 token：上游把 reasoning_tokens 算在 completion_tokens 里（03 §9.1）
      out: typeof root?.usage?.completion_tokens === 'number' ? root.usage.completion_tokens : 0
    }

    if (!allowEmpty && content.length === 0 && finishReason !== 'length') {
      throw appError('AI_PARSE_FAILED', AI_COPY.parseFailed, {
        retryable: true,
        detail: `content 为空（finish_reason=${finishReason}）`
      })
    }

    return { content, finishReason, usage }
  }
}
