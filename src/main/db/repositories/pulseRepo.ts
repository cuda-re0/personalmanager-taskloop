import type { Pulse, PulseCreateInput } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { PULSE_COLUMNS, mapPulse } from '../mappers'
import type { PulseRow } from '../mappers'
import { placeholders } from '../sqlUtil'

/**
 * pulses 的数据访问层（v0.86）。
 *
 * 与 `reminderRepo` 同口径：`getDb().prepare(...)` 直取，不新增抽象层；
 * 写操作统一经 `write()` 包 `wrapWriteError`，`NOT_FOUND` 原样透出（wrapWriteError
 * 对 AppErrorException 不做二次包装）。
 */

const SELECT_PULSE = `SELECT ${PULSE_COLUMNS.join(', ')} FROM pulses`

function write<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    throw wrapWriteError(e, '周期提醒写入失败')
  }
}

export function listAll(): Pulse[] {
  return (getDb()
    .prepare(`${SELECT_PULSE} ORDER BY created_at ASC`)
    .all() as PulseRow[]).map(mapPulse)
}

export function listEnabled(): Pulse[] {
  return (getDb()
    .prepare(`${SELECT_PULSE} WHERE enabled = 1 ORDER BY created_at ASC`)
    .all() as PulseRow[]).map(mapPulse)
}

export function getById(id: string): Pulse | null {
  const row = getDb().prepare(`${SELECT_PULSE} WHERE id = ?`).get(id) as PulseRow | undefined
  return row ? mapPulse(row) : null
}

export function requireById(id: string): Pulse {
  const pulse = getById(id)
  if (!pulse) throw appError('NOT_FOUND', '这一项不存在', { detail: `id=${id}` })
  return pulse
}

export function insert(input: PulseCreateInput & { id: string; now: string }): Pulse {
  write(() => {
    getDb()
      .prepare(
        `INSERT INTO pulses (${PULSE_COLUMNS.join(', ')})
         VALUES (${placeholders(PULSE_COLUMNS.length)})`
      )
      .run(
        input.id,
        input.title,
        input.intervalMinutes,
        input.windowStart ?? null,
        input.windowEnd ?? null,
        1,
        null,
        input.now,
        input.now
      )
  })
  return requireById(input.id)
}

export function setEnabled(id: string, enabled: boolean, updatedAt: string): Pulse {
  const changes = write(() =>
    getDb()
      .prepare('UPDATE pulses SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, updatedAt, id).changes
  )
  if (changes === 0) requireById(id)
  return requireById(id)
}

export function remove(id: string): void {
  const changes = write(() =>
    getDb().prepare('DELETE FROM pulses WHERE id = ?').run(id).changes
  )
  if (changes === 0) requireById(id)
}

/** 只写 last_fired_at 与 updated_at：写成功才算触发过 */
export function markFired(id: string, firedAt: string): void {
  write(() => {
    const changes = getDb()
      .prepare('UPDATE pulses SET last_fired_at = ?, updated_at = ? WHERE id = ?')
      .run(firedAt, firedAt, id).changes
    if (changes === 0) requireById(id)
  })
}

/**
 * 启动时的「不补发」重置：把所有启用项的 last_fired_at 顶到当下，
 * 于是 `isDue` 的差值判定在接下来一轮全部不成立，重启等于重新计时。
 */
export function resetLastFired(firedAt: string): number {
  return write(() =>
    getDb()
      .prepare('UPDATE pulses SET last_fired_at = ? WHERE enabled = 1')
      .run(firedAt).changes
  )
}
