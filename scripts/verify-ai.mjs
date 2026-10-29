#!/usr/bin/env node
/**
 * 真机验证脚本（开工词 §4.9）。
 *
 * `node scripts/verify-ai.mjs`        跑三项：纯文本 / 带图 / usage
 * `node scripts/verify-ai.mjs --quick` 只跑纯文本（03 §1 的复核命令）
 *
 * 纪律：
 * - **不打印 key**，一个字符都不打印；也不打印未截断的响应体（只留前 200 字符）。
 * - Key 来源：`process.env.ZHIPU_API_KEY` → 仓库根 `.env.local`（读它的值但**不回显**）。
 * - 用真 prompt（`src/main/ai/prompts/*.md`）：验证的不是"模型能不能说话"，而是
 *   "注入当前时间后 `due_hint` 到底有没有值"——这是 03 §9.5 的 P0。
 *
 * 与主进程的唯一重复是 `nowHint()` 的格式串。这里是 .mjs、导不进 TS，而格式由 03 §9.6
 * 冻结（改一处要同时改两处）。测试 `tests/ai/timeHint.test.ts` 守的是主进程那一份。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
const MODEL = process.env.ZHIPU_MODEL ?? 'glm-5.3-flash'
const TIMEOUT_MS = 90_000
const BODY_PREVIEW = 200
/** 8×8 纯红 PNG（75 字节），与 aiService 的探测图同一张 */
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC'

const WEEKDAY = { Sun: '星期日', Mon: '星期一', Tue: '星期二', Wed: '星期三', Thu: '星期四', Fri: '星期五', Sat: '星期六' }

function nowHint() {
  const now = new Date()
  const day = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .filter(p => p.type !== 'literal')
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {})
  const weekday = WEEKDAY[new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(now)] ?? ''
  const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  return (
    `【当前时间】${day.year}-${day.month}-${day.day} ${weekday} ${clock}（${zone}）\n` +
    '解析"明天/下周三/三小时后"这类相对时间时，一律以此为准，并换算成带时区的 ISO8601。'
  )
}

function readKey() {
  const fromEnv = (process.env.ZHIPU_API_KEY ?? '').trim()
  if (fromEnv) return fromEnv
  const file = join(ROOT, '.env.local')
  if (!existsSync(file)) return null
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq <= 0 || text.slice(0, eq).trim() !== 'ZHIPU_API_KEY') continue
    return text.slice(eq + 1).trim().replace(/^["']|["']$/g, '') || null
  }
  return null
}

function prompts() {
  const dir = join(ROOT, 'src', 'main', 'ai', 'prompts')
  return {
    base: readFileSync(join(dir, 'system.base.md'), 'utf8'),
    parse: readFileSync(join(dir, 'parse.system.md'), 'utf8'),
    fewshot: JSON.parse(readFileSync(join(dir, 'parse.fewshot.json'), 'utf8'))
  }
}

function fewshotMessages(file) {
  const messages = []
  for (const example of file.examples) {
    messages.push({ role: 'user', content: example.user })
    messages.push({ role: 'assistant', content: JSON.stringify(example.assistant) })
  }
  return messages
}

const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text)

async function callChat(key, { messages, withImage }) {
  const started = Date.now()
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 2048,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const latencyMs = Date.now() - started
  const text = await response.text()
  if (!response.ok) {
    return { ok: false, status: response.status, latencyMs, body: truncate(text, BODY_PREVIEW), withImage }
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, status: response.status, latencyMs, body: truncate(text, BODY_PREVIEW), withImage }
  }
  const choice = payload.choices?.[0] ?? {}
  const content = choice.message?.content ?? ''
  return {
    ok: true,
    status: response.status,
    latencyMs,
    withImage,
    content,
    finishReason: choice.finish_reason,
    usage: payload.usage ?? {},
    body: truncate(text, BODY_PREVIEW)
  }
}

function parseJson(content) {
  const stripped = content.trim().startsWith('```')
    ? content.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '')
    : content
  try {
    return JSON.parse(stripped)
  } catch {
    return null
  }
}

function reportUsage(usage) {
  const out = usage.completion_tokens ?? 0
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? null
  return (
    `usage: prompt_tokens=${usage.prompt_tokens ?? '?'} completion_tokens=${out} ` +
    `total_tokens=${usage.total_tokens ?? '?'} reasoning_tokens=${reasoning ?? '（无此字段）'}`
  )
}

async function main() {
  const quick = process.argv.includes('--quick')
  const key = readKey()
  if (!key) {
    console.error('[verify-ai] 没有找到 Key：设 ZHIPU_API_KEY，或在仓库根放 .env.local（ZHIPU_API_KEY=…）')
    process.exit(1)
  }

  const prompt = prompts()
  const system = `${prompt.base}\n\n${prompt.parse}\n\n${nowHint()}`
  const results = []
  const userText = '明天下午三点前把季度报告初稿写完'

  // ---- 1/3 纯文本 ----
  console.log(`\n[1/${quick ? 1 : 3}] 纯文本建任务：${userText}`)
  console.log(`  模型: ${MODEL}`)
  const textResult = await callChat(key, {
    withImage: false,
    messages: [
      { role: 'system', content: system },
      ...fewshotMessages(prompt.fewshot),
      { role: 'user', content: userText }
    ]
  })
  if (!textResult.ok) {
    console.log(`  ✗ HTTP ${textResult.status}，${textResult.latencyMs}ms`)
    console.log(`  响应体(前 ${BODY_PREVIEW} 字): ${textResult.body}`)
    results.push(false)
  } else {
    console.log(`  finish_reason: ${textResult.finishReason}`)
    console.log(`  耗时: ${(textResult.latencyMs / 1000).toFixed(1)}s`)
    console.log(`  ${reportUsage(textResult.usage)}`)
    const parsed = parseJson(textResult.content)
    console.log(`  JSON 可解析: ${parsed ? '是' : '否'}（content ${textResult.content.length} 字符）`)
    if (parsed) {
      const task = parsed.tasks?.[0] ?? {}
      console.log(`  intent: ${parsed.intent ?? '(缺)'}  type: ${task.type ?? '(缺)'}`)
      console.log(`  title: ${task.title ?? '(缺)'}`)
      console.log(`  due_hint: ${JSON.stringify(task.due_hint ?? null)}   ← 03 §9.5 的 P0`)
      console.log(`  difficulty: ${task.difficulty ?? '(缺)'}  requires_evidence: ${task.requires_evidence}`)
    }
    console.log(`  响应体(前 ${BODY_PREVIEW} 字): ${textResult.body}`)
    results.push(Boolean(parsed) && textResult.latencyMs > 3000)
  }

  if (!quick) {
    // ---- 2/3 带图 ----
    console.log('\n[2/3] 带图（8×8 纯红 PNG）：这张图片主要是什么颜色？')
    const imageResult = await callChat(key, {
      withImage: true,
      messages: [
        { role: 'system', content: '你只能输出一个 JSON 对象，不要任何解释。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图片主要是什么颜色？只输出 {"color":"颜色"}。' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_PNG}` } }
          ]
        }
      ]
    })
    if (!imageResult.ok) {
      console.log(`  ✗ HTTP ${imageResult.status}，${imageResult.latencyMs}ms`)
      console.log(`  响应体(前 ${BODY_PREVIEW} 字): ${imageResult.body}`)
      results.push(false)
    } else {
      const parsed = parseJson(imageResult.content) ?? {}
      const eatsImage = /红|red/i.test(String(parsed.color ?? imageResult.content))
      console.log(`  finish_reason: ${imageResult.finishReason}`)
      console.log(`  耗时: ${(imageResult.latencyMs / 1000).toFixed(1)}s`)
      console.log(`  ${reportUsage(imageResult.usage)}`)
      console.log(`  回答: ${String(parsed.color ?? imageResult.content).slice(0, 40)}`)
      console.log(`  是否吃图: ${eatsImage ? '是' : '否'}`)
      console.log(`  响应体(前 ${BODY_PREVIEW} 字): ${imageResult.body}`)
      results.push(eatsImage)
    }

    // ---- 3/3 usage ----
    console.log('\n[3/3] usage 字段完整性')
    if (!textResult.ok) {
      console.log('  ✗ 第一次调用就失败了，usage 无从检查')
      results.push(false)
    } else {
      const usage = textResult.usage ?? {}
      const keys = Object.keys(usage)
      const reasoning = usage.completion_tokens_details?.reasoning_tokens
      console.log(`  usage 字段: ${keys.length > 0 ? keys.join(', ') : '(空)'}`)
      console.log(`  reasoning_tokens: ${reasoning ?? '（无）'}`)
      console.log(
        `  completion_tokens(${usage.completion_tokens ?? 0}) 与 content 长度(${textResult.content.length}) 的关系：` +
          '推理 token 也算在 completion_tokens 里（03 §9.1）'
      )
      results.push(keys.includes('prompt_tokens') && keys.includes('completion_tokens'))
    }
  }

  const passed = results.filter(Boolean).length
  console.log(`\n结果: ${passed}/${results.length} 项通过`)
  console.log(
    '提示: 这里用的是 .env.local 或环境变量里的**同一个** Key，脚本不会打印它。' +
      '交付时只用 key 前 6 位做仓库自检，不要写进任何文件。'
  )
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(error => {
  console.error('[verify-ai] 未捕获异常：', error instanceof Error ? error.message : error)
  process.exit(1)
})
