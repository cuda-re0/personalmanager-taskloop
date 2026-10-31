import type { Persona, PersonaTone } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { nowIso } from '../localDay'

/**
 * personas 的数据访问层（01 §2.8）。只做 SQL，不做业务判断——
 * 长度校验与错误模板在 `personaService`。
 *
 * 表支持多张，v1 只用一张：唯一部分索引 `idx_personas_active` 保证「同时最多一张 active」，
 * `setActive` 在同一事务里先把别的置 0 再置 1。
 */

const COLUMNS = [
  'id',
  'name',
  'user_call',
  'persona_md',
  'tone',
  'is_active',
  'created_at',
  'updated_at'
] as const

const SELECT = `SELECT ${COLUMNS.join(', ')} FROM personas`

interface PersonaRow {
  id: string
  name: string
  user_call: string
  persona_md: string
  tone: string
  is_active: number
  created_at: string
  updated_at: string
}

const TONES: readonly PersonaTone[] = ['warm', 'plain', 'playful']

/** 非法 tone 一律按 warm（01 §2.8 末条），不给旧值留兼容分支 */
function toneOf(raw: string): PersonaTone {
  return (TONES as readonly string[]).includes(raw) ? (raw as PersonaTone) : 'warm'
}

function mapPersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    userCall: row.user_call,
    personaMd: row.persona_md,
    tone: toneOf(row.tone),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function getActive(): Persona | null {
  const row = getDb()
    .prepare(`${SELECT} WHERE is_active = 1 ORDER BY created_at ASC, rowid ASC LIMIT 1`)
    .get() as PersonaRow | undefined
  return row ? mapPersona(row) : null
}

/** 全部人物卡，按创建时间升序。v1 只可能有一行，给 `personaService.get` 兜脏数据用 */
export function list(): Persona[] {
  const rows = getDb()
    .prepare(`${SELECT} ORDER BY created_at ASC, rowid ASC`)
    .all() as PersonaRow[]
  return rows.map(mapPersona)
}

/**
 * 建默认行（`persona.get` 发现表空时用）。**迁移不写业务数据**（01 §5），
 * 所以第一行是这里就地建的：`id='default'`、`name='小助手'`、其余空、`tone='warm'`。
 */
export function insertDefault(): Persona {
  const now = nowIso()
  try {
    getDb()
      .prepare(
        `INSERT INTO personas (${COLUMNS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('default', '小助手', '', '', 'warm', 1, now, now)
  } catch (e) {
    throw wrapWriteError(e, '人物卡写入失败')
  }
  return requireById('default')
}

export interface PersonaUpdate {
  name?: string
  userCall?: string
  personaMd?: string
  tone?: PersonaTone
}

export function update(id: string, patch: PersonaUpdate): Persona {
  const sets: string[] = []
  const values: (string | number)[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    values.push(patch.name)
  }
  if (patch.userCall !== undefined) {
    sets.push('user_call = ?')
    values.push(patch.userCall)
  }
  if (patch.personaMd !== undefined) {
    sets.push('persona_md = ?')
    values.push(patch.personaMd)
  }
  if (patch.tone !== undefined) {
    sets.push('tone = ?')
    values.push(patch.tone)
  }
  if (sets.length === 0) return requireById(id)

  sets.push('updated_at = ?')
  values.push(nowIso())
  try {
    const changes = getDb()
      .prepare(`UPDATE personas SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, id).changes
    if (changes === 0) throw appError('NOT_FOUND', '人物卡不存在', { detail: `id=${id}` })
  } catch (e) {
    throw wrapWriteError(e, '人物卡写入失败')
  }
  return requireById(id)
}

/** 同一事务内先清后置：唯一部分索引只允许一张 active，分两步写会中途撞索引 */
export function setActive(id: string): void {
  const db = getDb()
  const run = db.transaction(() => {
    db.prepare('UPDATE personas SET is_active = 0 WHERE id <> ?').run(id)
    const changes = db
      .prepare('UPDATE personas SET is_active = 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), id).changes
    if (changes === 0) throw appError('NOT_FOUND', '人物卡不存在', { detail: `id=${id}` })
  })
  try {
    run()
  } catch (e) {
    throw wrapWriteError(e, '人物卡写入失败')
  }
}

export function requireById(id: string): Persona {
  const row = getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as PersonaRow | undefined
  if (!row) throw appError('NOT_FOUND', '人物卡不存在', { detail: `id=${id}` })
  return mapPersona(row)
}
