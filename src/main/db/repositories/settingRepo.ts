import type { AppSettings } from '../../../shared/types/ipc'
import { getDb } from '../connection'
import { appError, wrapWriteError } from '../errors'
import { cloneDefaultSettings, isSettingKey } from '../defaultSettings'
import { nowIso } from '../localDay'
import { parseJsonColumn } from '../mappers'

/**
 * settings 的数据访问层。
 *
 * 规则（08 DELTA · D2 / W1-3 / W1-4）：
 * - DB 里**只存用户改过的 key**；`getAll()` 用 `DEFAULT_SETTINGS` 做底浅合并，保证返回的是
 *   `AppSettings` **全量**——渲染层不处理 `undefined`，缺 key 就是这里的 bug。
 * - value 是 JSON 字符串，`JSON.parse` 失败**必须抛错**，不能静默回默认值
 *   （否则用户配错 webhook 永远收不到通知，而且没有任何线索）。
 * - key 是封闭集合（14 个，不含 `ai.apiKey`），写未登记的 key 直接拒。
 */

interface SettingRow {
  key: string
  value_json: string
  updated_at: string
}

export function getAll(): AppSettings {
  const rows = getDb().prepare('SELECT key, value_json, updated_at FROM settings').all() as SettingRow[]
  const merged = cloneDefaultSettings()
  const target = merged as unknown as Record<string, unknown>
  for (const row of rows) {
    // 库里残留了本版 AppSettings 没有的 key（比如降级后）：忽略，不要污染返回类型。
    // 注意不是静默"吞掉用户配置"——值仍在库里，升回新版本就还在。
    if (!isSettingKey(row.key)) continue
    target[row.key] = parseJsonColumn<unknown>(row.value_json, `settings.${row.key}`)
  }
  return merged
}

export function get<K extends keyof AppSettings>(key: K): AppSettings[K] {
  const fallback = cloneDefaultSettings()[key]
  const row = getDb().prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined
  if (!row) return fallback
  return parseJsonColumn<AppSettings[K]>(row.value_json, `settings.${String(key)}`)
}

export function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings[K] {
  if (!isSettingKey(key)) {
    throw appError('INVALID_INPUT', '未知的配置项', { detail: String(key) })
  }
  if (value === undefined) {
    throw appError('INVALID_INPUT', '配置值不能是 undefined', { detail: String(key) })
  }
  const json = JSON.stringify(value)
  try {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, json, nowIso())
  } catch (e) {
    throw wrapWriteError(e, '配置写入失败')
  }
  return get(key)
}

/** 删掉某条覆盖，回到默认值 */
export function reset(key: keyof AppSettings): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export function listOverriddenKeys(): string[] {
  const rows = getDb().prepare('SELECT key FROM settings ORDER BY key ASC').all() as { key: string }[]
  return rows.map(r => r.key)
}
