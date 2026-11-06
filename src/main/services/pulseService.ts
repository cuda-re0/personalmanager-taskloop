import type { Pulse, PulseCreateInput } from '../../shared/types/domain'
import { appError } from '../db/errors'
import { newId } from '../db/ids'
import { nowIso } from '../db/localDay'
import * as pulseRepo from '../db/repositories/pulseRepo'

/**
 * 高频周期提醒的业务层（v0.86）。
 *
 * `inWindow` / `isDue` 是**纯函数**：不碰库、不取当前时间，调度器与测试都能直接调。
 * 其余四个是 CRUD 透传；标题 / 间隔 / 窗口的校验只在 create 这一处收口。
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 判定顺序写死：缺任一端或两端相等 → 全天；不跨午夜 → 左闭右开；
 * 跨午夜（start > end）→ 两段并集。字符串比较对 'HH:mm' 补零格式等价于时刻比较。
 */
export function inWindow(hhmm: string, start: string | null, end: string | null): boolean {
  if (start === null || end === null) return true
  if (start === end) return true
  if (start < end) return start <= hhmm && hhmm < end
  return hhmm >= start || hhmm < end
}

/** 本地时刻：不许用 getUTCHours 系列，午夜窗口会整整偏 8 小时 */
function localHhmm(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function isDue(pulse: Pulse, now: Date): boolean {
  if (!pulse.enabled) return false
  if (!inWindow(localHhmm(now), pulse.windowStart, pulse.windowEnd)) return false
  if (pulse.lastFiredAt === null) return true
  return now.getTime() - Date.parse(pulse.lastFiredAt) >= pulse.intervalMinutes * 60_000
}

/** 空串与 undefined 都归一成 null：库里不许存 ''，否则 inWindow 会把它当成一个真实时刻 */
function normalizeWindow(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value
}

export function list(): Pulse[] {
  return pulseRepo.listAll()
}

export function create(input: PulseCreateInput): Pulse {
  const title = input.title.trim()
  if (title === '') throw appError('INVALID_INPUT', '标题不能为空')
  if (title.length > 40) throw appError('INVALID_INPUT', '标题不能超过 40 个字')

  const interval = input.intervalMinutes
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
    throw appError('INVALID_INPUT', '间隔必须在 1 到 1440 分钟之间')
  }

  const windowStart = normalizeWindow(input.windowStart)
  const windowEnd = normalizeWindow(input.windowEnd)
  if ((windowStart === null) !== (windowEnd === null)) {
    throw appError('INVALID_INPUT', '提醒区间要么都填，要么都不填')
  }
  if (windowStart !== null && !HHMM.test(windowStart)) {
    throw appError('INVALID_INPUT', '时间格式应为 HH:mm')
  }
  if (windowEnd !== null && !HHMM.test(windowEnd)) {
    throw appError('INVALID_INPUT', '时间格式应为 HH:mm')
  }

  return pulseRepo.insert({
    id: newId(),
    now: nowIso(),
    title,
    intervalMinutes: interval,
    windowStart,
    windowEnd
  })
}

export function setEnabled(id: string, enabled: boolean): Pulse {
  return pulseRepo.setEnabled(id, enabled, nowIso())
}

export function remove(id: string): void {
  pulseRepo.remove(id)
}
