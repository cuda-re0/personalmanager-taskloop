import { describe, expect, it } from 'vitest'
import { GlmClient, stripFence } from '../../src/main/ai/glmClient'
import { ParseResultSchema } from '../../src/main/ai/schema'
import { AI_COPY } from '../../src/main/ai/copy'
import { chatResponse, errorResponse, fakeFetch } from './helpers'

/**
 * `GlmClient` 的解析与重试（开工词 §6 的第 1–5 条）。
 * 全部用假 fetch 打本地假响应，**不打真网络**。
 */

/** 最小合法 ParseResult（单条 deadline） */
const VALID = JSON.stringify({
  intent: 'create_task',
  reply: '记成限时任务了。',
  tasks: [
    {
      type: 'deadline',
      title: '写季度报告初稿',
      detail_md: '整理数据后写初稿。',
      requires_evidence: true,
      difficulty: 'medium',
      estimate_min: 90,
      due_hint: '2026-10-30T15:00:00+08:00',
      daily_time_hint: null,
      tags: ['工作'],
      steps: [],
      missing_info: [],
      confidence: 0.9
    }
  ]
})

function client(fetchImpl: ReturnType<typeof fakeFetch>): GlmClient {
  return new GlmClient({ apiKey: 'test-key-abcd', model: 'glm-5.3-flash', fetchImpl })
}

async function runChat(fetchImpl: ReturnType<typeof fakeFetch>) {
  return client(fetchImpl).chatJson({
    messages: [{ role: 'user', content: '明天下午三点前把季度报告初稿写完' }],
    schema: ParseResultSchema
  })
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE'
  }
  throw new Error('预期抛错，实际成功')
}

describe('stripFence（剥 markdown 围栏）', () => {
  it('```json 围栏、``` 围栏、纯 JSON、前后带空白，四种都能解', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripFence('{"a":1}')).toBe('{"a":1}')
    expect(stripFence('\n\n  {"a":1}  \n\n')).toBe('{"a":1}')
    // 单行形态也认（模型偶尔不换行）
    expect(stripFence('```json{"a":1}```')).toBe('{"a":1}')
    // 不是围栏的形态原样返回，不猜
    expect(stripFence('{"a":"```"}')).toBe('{"a":"```"}')
  })
})

describe('GlmClient 解析与重试', () => {
  it('四种围栏形态都能解出对象（走完整 chatJson）', async () => {
    for (const raw of [`\`\`\`json\n${VALID}\n\`\`\``, `\`\`\`\n${VALID}\n\`\`\``, VALID, `\n ${VALID} \n`]) {
      const fetchImpl = fakeFetch([chatResponse(raw)])
      const result = await runChat(fetchImpl)
      expect(result.data.intent).toBe('create_task')
      expect(fetchImpl.calls).toBe(1)
    }
  })

  it('reasoning_content 丢弃：只解析 content', async () => {
    // chatResponse 里的 reasoning_content 是 {"intent":"reasoning"}，若被拼进 JSON 就会解析失败
    const result = await runChat(fakeFetch([chatResponse(VALID)]))
    expect(result.data.intent).toBe('create_task')
    expect(result.usage).toEqual({ in: 39, out: 172 })
  })

  it('finish_reason=length + 空 content → AI_PARSE_FAILED，且只请求了 1 次（不重试）', async () => {
    const fetchImpl = fakeFetch([chatResponse('', { finish: 'length' })])
    expect(await codeOf(() => runChat(fetchImpl))).toBe('AI_PARSE_FAILED')
    expect(fetchImpl.calls).toBe(1)
  })

  it('zod 不过 → 重试 1 次 → 仍不过 → AI_PARSE_FAILED，共 2 次请求', async () => {
    const bad = chatResponse(JSON.stringify({ intent: 'create_task', reply: 'x' })) // 缺 tasks
    const fetchImpl = fakeFetch([bad, bad])
    expect(await codeOf(() => runChat(fetchImpl))).toBe('AI_PARSE_FAILED')
    expect(fetchImpl.calls).toBe(2)
  })

  it('首次不合格、第二次合格 → 成功返回，共 2 次请求', async () => {
    const fetchImpl = fakeFetch([
      chatResponse(JSON.stringify({ intent: 'create_task', reply: 'x' })),
      chatResponse(VALID)
    ])
    const result = await runChat(fetchImpl)
    expect(result.data.tasks).toHaveLength(1)
    expect(fetchImpl.calls).toBe(2)
  })

  it('intent 被照抄成 "create_task|review_task" → 走重试，不 split 猜一个', async () => {
    const placeholder = JSON.stringify({ intent: 'create_task|review_task', reply: 'x', tasks: [] })
    const fetchImpl = fakeFetch([chatResponse(placeholder), chatResponse(VALID)])
    const result = await runChat(fetchImpl)
    expect(fetchImpl.calls).toBe(2)
    // 取到的是第二次的合法值；没有任何"取竖线左边"的分支会产出这个字符串
    expect(result.data.intent).toBe('create_task')
    // 重试消息里带了上一次的 issues，模型才知道该改什么
    const retryBody = fetchImpl.bodies[1] as { messages: Array<{ content: unknown }> }
    expect(String(retryBody.messages[retryBody.messages.length - 1].content)).toContain('没有通过校验')
  })

  it('status 映射：401 → AI_NOT_CONFIGURED、429 → AI_RATE_LIMITED、500 → AI_UPSTREAM_ERROR', async () => {
    const unauthorized = fakeFetch([errorResponse(401, '{"error":"bad key"}')])
    expect(await codeOf(() => runChat(unauthorized))).toBe('AI_NOT_CONFIGURED')

    const limited = fakeFetch([errorResponse(429, '{"error":"rate"}')])
    expect(await codeOf(() => runChat(limited))).toBe('AI_RATE_LIMITED')

    const broken = fakeFetch([errorResponse(503, '{"error":"boom"}')])
    expect(await codeOf(() => runChat(broken))).toBe('AI_UPSTREAM_ERROR')
  })

  it('错误 detail 里不出现 key（连前 6 位都不行）', async () => {
    const apiKey = 'abcdef1234567890'
    const fetchImpl = fakeFetch([errorResponse(500, '{"error":"invalid token abcdef1234567890"}')])
    const c = new GlmClient({ apiKey, model: 'glm-5.3-flash', fetchImpl })
    try {
      await c.chatJson({ messages: [{ role: 'user', content: 'x' }], schema: ParseResultSchema })
      throw new Error('预期抛错')
    } catch (e) {
      const err = e as { code?: string; detail?: string; message?: string }
      expect(err.code).toBe('AI_UPSTREAM_ERROR')
      expect(err.detail ?? '').not.toContain('abcdef')
      expect(err.message).not.toContain('abcdef')
    }
  })

  it('请求体：max_tokens 固定 10000、带 response_format、temperature 可覆盖', async () => {
    const fetchImpl = fakeFetch([chatResponse(VALID)])
    await runChat(fetchImpl)
    const body = fetchImpl.bodies[0] as { max_tokens: number; response_format: unknown }
    expect(body.max_tokens).toBe(10000)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('中断（外部 signal）→ AiAbortedError，不是 AI_* 错误', async () => {
    const controller = new AbortController()
    const fetchImpl = (async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }) as unknown as ReturnType<typeof fakeFetch>
    const c = new GlmClient({ apiKey: 'k', model: 'm', fetchImpl })
    let thrown: unknown
    try {
      await c.chatJson({
        messages: [{ role: 'user', content: 'x' }],
        schema: ParseResultSchema,
        signal: controller.signal
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { name?: string }).name).toBe('AiAbortedError')
  })

  it('空 content 且非 length → AI_PARSE_FAILED（detail 说明 finish_reason）', async () => {
    const fetchImpl = fakeFetch([chatResponse('', { finish: 'stop' })])
    expect(await codeOf(() => runChat(fetchImpl))).toBe('AI_PARSE_FAILED')
    expect(fetchImpl.calls).toBe(1)
  })

  it('AI_PARSE_FAILED 的 message 用的是登记在 copy.ts 里的那句', async () => {
    const fetchImpl = fakeFetch([chatResponse('不是 JSON')])
    try {
      await runChat(fetchImpl)
      throw new Error('预期抛错')
    } catch (e) {
      expect((e as { message: string }).message).toBe(AI_COPY.parseFailed)
    }
  })
})
