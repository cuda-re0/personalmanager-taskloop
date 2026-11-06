import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

/** 78 单 · 更新载荷（JSON + base64）的解析与落盘。 */

export interface UpdatePayload {
  version: string
  files: Record<string, string>
}

/** 上限（v0.83）：一个正常产物约 1.1 MB，这些值留足余量又不至于被一个坏包打爆内存 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_FILES = 200
/** 字符表 + `=` 只能在尾部、最多两个 */
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertSafeKey(key: string): void {
  if (key.length === 0) throw new Error('载荷里出现空文件名')
  if (key.includes('\\')) throw new Error(`载荷文件名含反斜杠：${key}`)
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
    throw new Error(`载荷文件名是绝对路径：${key}`)
  }
  if (key.split('/').includes('..')) throw new Error(`载荷文件名含越界路径段：${key}`)
}

/**
 * 校验 base64 形状并返回解码后字节数。
 *
 * 不校验就直接 `Buffer.from(v,'base64')` 的话，非法字符会被静默丢弃、产出截断文件——
 * 结果是一个"版本号对、代码坏"的安装，而且重启后版本已变、再也不会自愈。
 */
function base64Bytes(key: string, value: string): number {
  if (value.length % 4 !== 0 || !BASE64_SHAPE.test(value)) {
    throw new Error(`更新包文件不是合法 base64：${key}`)
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const bytes = (value.length / 4) * 3 - padding
  if (bytes <= 0) throw new Error(`更新包文件内容为空：${key}`)
  if (bytes > MAX_FILE_BYTES) throw new Error(`更新包单文件超过 8 MiB：${key}`)
  return bytes
}

export function parsePayload(raw: string): UpdatePayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('更新包不是合法 JSON')
  }
  if (!isPlainObject(parsed)) throw new Error('更新包格式不对')

  const version = parsed.version
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('更新包缺少版本号')
  }
  const rawFiles = parsed.files
  if (!isPlainObject(rawFiles) || Object.keys(rawFiles).length === 0) {
    throw new Error('更新包里没有文件')
  }

  const entries = Object.entries(rawFiles)
  if (entries.length > MAX_FILES) throw new Error(`更新包文件数超过 ${MAX_FILES}`)

  const files: Record<string, string> = {}
  let total = 0
  for (const [key, value] of entries) {
    assertSafeKey(key)
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`更新包文件内容为空：${key}`)
    }
    total += base64Bytes(key, value)
    if (total > MAX_TOTAL_BYTES) throw new Error('更新包解压后超过 32 MiB')
    files[key] = value
  }
  return { version, files }
}

export function writePayloadTree(payload: UpdatePayload, targetDir: string): number {
  const root = resolve(targetDir)
  const prefix = root + sep
  let written = 0
  for (const [key, value] of Object.entries(payload.files)) {
    const target = resolve(root, key)
    if (!target.startsWith(prefix)) {
      console.warn(`[update] 跳过越界文件：${key}`)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(value, 'base64'))
    written += 1
  }
  return written
}
