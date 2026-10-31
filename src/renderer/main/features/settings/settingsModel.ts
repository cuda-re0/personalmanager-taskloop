import type { MemoryKind, MemorySource, Persona, PersonaTone } from '@shared/types/domain'
import type { Api } from '@shared/types/ipc'

/**
 * 设置抽屉的纯逻辑与文案表（v0.44，04 §1 文案纪律）。
 *
 * 这里只放**没有副作用、也不碰 React** 的东西：三张 label 表、表单投影、脏值差分、
 * 新增按钮的可用判据。抽屉里的三个块（人物卡 / 记忆 / AI）直接吃这些导出，
 * 界面上的中文串因此只有「表里的一份」和「组件里的字面量」两处来源，
 * 白名单断言（`settingsWiring.test.ts`）盯的就是后者。
 *
 * `PersonaPatch` 不另抄一份形状：直接用 `persona.update` 的入参类型。
 * 契约改了这里跟着改，抄一份只会多出一个会分叉的定义。
 */

/** `persona.update` 的入参（局部更新，只提交有变化的字段） */
export type PersonaPatch = Parameters<Api['persona']['update']>[0]

/** 人物卡里四个**可编辑**字段；`id` / `isActive` / 时间戳不进口表单 */
export interface PersonaForm {
  name: string
  userCall: string
  personaMd: string
  tone: PersonaTone
}

/** 记忆长度上限（与 `memoryService.MEMORY_MAX_CHARS` 同值，这里只用来判按钮可用性） */
const MEMORY_MAX_CHARS = 120

/** 语气三项的固定顺序（04：`温柔` `直率` `活泼`，不按用户习惯重排） */
export const TONE_ORDER = ['warm', 'plain', 'playful'] as const satisfies readonly PersonaTone[]

/** 新增记忆时 select 的固定顺序（`身份` `偏好` `事实`） */
export const KIND_ORDER = ['profile', 'preference', 'fact'] as const satisfies readonly MemoryKind[]

export const TONE_LABEL: Record<PersonaTone, string> = {
  warm: '温柔',
  plain: '直率',
  playful: '活泼'
}

export const KIND_LABEL: Record<MemoryKind, string> = {
  profile: '身份',
  preference: '偏好',
  fact: '事实'
}

export const SOURCE_LABEL: Record<MemorySource, string> = {
  auto: '自动',
  manual: '手动'
}

/** `Persona` → 表单快照（丢掉 `id` / `isActive` / 时间戳） */
export function toPersonaForm(persona: Persona): PersonaForm {
  return {
    name: persona.name,
    userCall: persona.userCall,
    personaMd: persona.personaMd,
    tone: persona.tone
  }
}

/**
 * 表单与「已保存快照」逐字段比较，**只返回有变化的字段**；全等返回 `null`。
 *
 * 不做 `trim`：契约里长度与空值校验都在主干（`personaService`），
 * 渲染层自己先削一刀，会让「名字改成空格」在后端拿到空串、报的却是另一句话。
 */
export function diffPersona(form: PersonaForm, saved: PersonaForm): PersonaPatch | null {
  const patch: PersonaPatch = {}
  if (form.name !== saved.name) patch.name = form.name
  if (form.userCall !== saved.userCall) patch.userCall = form.userCall
  if (form.personaMd !== saved.personaMd) patch.personaMd = form.personaMd
  if (form.tone !== saved.tone) patch.tone = form.tone
  return Object.keys(patch).length === 0 ? null : patch
}

/**
 * `[添加]` 的可用判据：`trim()` 后 1~120 个字符（按字符数，不按 `String.length`）。
 *
 * 只管这一条：撞 50 条上限、内容重复都由后端判——前端不预判，
 * 否则同一套规则会长成两份，改一份就分叉。
 */
export function canAddMemory(raw: string): boolean {
  const chars = Array.from(raw.trim()).length
  return chars >= 1 && chars <= MEMORY_MAX_CHARS
}
