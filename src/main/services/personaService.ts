import type { Persona, PersonaTone } from '../../shared/types/domain'
import { appError } from '../db/errors'
import * as personaRepo from '../db/repositories/personaRepo'

/**
 * personaService —— 人物卡的读取与局部更新（02 §3.8）。
 *
 * 业务规则只有三条，全在这里：
 * 1. 表空时**就地建默认行**再返回，绝不因为「没配人设」报错（01 §2.8）；
 * 2. 长度校验与错误模板（`name` 1~20、`userCall` ≤20、`personaMd` ≤800）；
 * 3. 不广播任何事件——Persona 不是 settings，改动下一轮聊天自然生效。
 *
 * 长度按**字符**数（`Array.from`）算，不是 `String.length`：中文以外的 emoji 是代理对，
 * `.length` 会把一个字符算成 2，用户在 20 字边界上会被莫名其妙拦住。
 */

const TONES: readonly PersonaTone[] = ['warm', 'plain', 'playful']

function charCount(text: string): number {
  return Array.from(text).length
}

export function get(): Persona {
  const active = personaRepo.getActive()
  if (active !== null) return active

  // 有行但都不 active（理论上唯一部分索引挡得住，这里兜住历史脏数据）：
  // 把最早那张置 active，而不是硬插一张——插 'default' 会撞主键
  const any = personaRepo.list()[0]
  if (any !== undefined) {
    personaRepo.setActive(any.id)
    return personaRepo.requireById(any.id)
  }
  return personaRepo.insertDefault()
}

export interface PersonaPatch {
  name?: string
  userCall?: string
  personaMd?: string
  tone?: PersonaTone
}

export function update(patch: PersonaPatch): Persona {
  const current = get()
  const next: personaRepo.PersonaUpdate = {}

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (charCount(name) === 0) throw appError('INVALID_INPUT', '助手名字不能为空')
    if (charCount(name) > 20) throw appError('INVALID_INPUT', '助手名字最多 20 个字')
    next.name = name
  }
  if (patch.userCall !== undefined) {
    const userCall = patch.userCall.trim()
    if (charCount(userCall) > 20) throw appError('INVALID_INPUT', '称呼最多 20 个字')
    next.userCall = userCall
  }
  if (patch.personaMd !== undefined) {
    if (charCount(patch.personaMd) > 800) throw appError('INVALID_INPUT', '人设最多 800 个字')
    next.personaMd = patch.personaMd
  }
  if (patch.tone !== undefined) {
    // 非法 tone 按 warm 处理（01 §2.8）：不报错，也不把脏值写进库
    next.tone = TONES.includes(patch.tone) ? patch.tone : 'warm'
  }

  return personaRepo.update(current.id, next)
}
