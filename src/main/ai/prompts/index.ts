import type { ChatMessage } from '../provider'
import { nowHint } from '../timeHint'
import chatSystem from './chat.system.md?raw'
import fewshot from './parse.fewshot.json'
import parseSystem from './parse.system.md?raw'
import memorySystem from './memory.system.md?raw'
import reviewSystem from './review.system.md?raw'
import summarizeSystem from './summarize.system.md?raw'
import fxSystem from './fx.system.md?raw'
import systemBase from './system.base.md?raw'

/**
 * Prompt 的装载与拼装（03 §7）。
 *
 * 三件事必须放在主进程（03 §3.0）：prompt 是这产品最需要反复调的东西，
 * 改一行重启就能试；一旦外置到某个服务，改 prompt 要重新部署，而且主程序与服务的
 * 版本会各自漂移，同一个任务在两个版本下表现不同，排查成本极高。
 *
 * **`.md` 用 `?raw` 导入**：构建与 vitest 都由 Vite 处理，打包后是打进 JS 的字符串，
 * 不依赖运行时文件路径（`__dirname` 在打包产物里指向 asar 内部，读文件很容易踩空）。
 * 好处是这四个文件还能被架构方逐句审，不用在 TS 字符串里读 prompt。
 */

/**
 * 去掉文件头那条 `<!-- v1 … -->` 版本注释：它是给人看的，不该进 prompt。
 * 只用于 v0.37 的三份新 prompt——`parse` / `review` 的现有文本一个字不动。
 */
function bodyOf(raw: string): string {
  return raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim()
}

export const SYSTEM_BASE = systemBase
export const PARSE_SYSTEM = parseSystem
export const REVIEW_SYSTEM = reviewSystem
/** v0.37：chat 管线的第五段（铁律），逐字来自 03 §4.3.1 */
export const CHAT_RULES = bodyOf(chatSystem)
/** v0.37：记忆自动提取的 system（03 §4.4） */
export const MEMORY_SYSTEM = bodyOf(memorySystem)
/** v0.37：摘要压缩的 system（01 §2.10） */
export const SUMMARIZE_SYSTEM = bodyOf(summarizeSystem)
/** v0.45：零花钱汇率评估的 system（45 §5.3）；后台任务，不拼人格 */
export const FX_SYSTEM = bodyOf(fxSystem)

/** 每组 prompt 的首行有版本注释，这里再导出一份便于埋点/日志核对 */
export const PROMPT_VERSION = 'v1 2026-10-29'

interface FewshotExample {
  label: string
  user: string
  assistant: unknown
}

interface FewshotFile {
  version: string
  note: string
  examples: FewshotExample[]
}

const FEWSHOT = fewshot as FewshotFile

/**
 * fewshot 摊平成消息对（user / assistant）。
 *
 * assistant 一侧把示例对象 `JSON.stringify` 回去：模型学的是"最终要输出的形状"，
 * 给它一段 prettify 过的对象比给它散文说明有效得多。
 */
export function parseFewshotMessages(): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const example of FEWSHOT.examples) {
    messages.push({ role: 'user', content: example.user })
    messages.push({ role: 'assistant', content: JSON.stringify(example.assistant) })
  }
  return messages
}

/**
 * parse 的 system 消息 = 人格 + 约束 + 【当前时间】。
 *
 * 当前时间必须**贴在 system 末尾**（03 §9.6）：模型对末尾的指令最敏感，
 * 而这一条是 `due_hint` 能不能填出来的唯一依据（§9.5 的 P0）。
 */
export function buildParseSystem(now: Date = new Date(), timeZone?: string): string {
  return `${SYSTEM_BASE}\n\n${PARSE_SYSTEM}\n\n${nowHint(now, timeZone)}`
}

/** review 的 system 消息，同样以【当前时间】结尾（判断"逾期了没有"也要知道今天几号） */
export function buildReviewSystem(now: Date = new Date(), timeZone?: string): string {
  return `${SYSTEM_BASE}\n\n${REVIEW_SYSTEM}\n\n${nowHint(now, timeZone)}`
}
