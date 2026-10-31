import type { Memory, MemoryKind, MemorySource } from '../../shared/types/domain'
import { AppErrorException, appError } from '../db/errors'
import * as memoryRepo from '../db/repositories/memoryRepo'

/**
 * memoryService —— 长期记忆的读写（02 §3.8、01 §2.9）。
 *
 * 三条规则写在这里，不让它们散到 IPC / 管线里：
 * 1. **上限 50 条**。手动添加撞上限 → `INVALID_INPUT`「记忆已达 50 条，请先删几条」，
 *    **不淘汰用户手写的东西**；只有自动提取（`addAuto`）满 50 时才先淘汰一条。
 * 2. 长度 1~120 字（按字符数，不按 `String.length`）。
 * 3. `source` 由调用路径决定：`addManual` 恒 `'manual'`，`addAuto` 恒 `'auto'`，
 *    渲染层传来的 source 一律忽略。
 */

export const MEMORY_LIMIT = 50
export const MEMORY_MAX_CHARS = 120

function charCount(text: string): number {
  return Array.from(text).length
}

function normalize(contentMd: string): string {
  const text = contentMd.trim()
  if (charCount(text) === 0) throw appError('INVALID_INPUT', '记忆内容不能为空')
  if (charCount(text) > MEMORY_MAX_CHARS) throw appError('INVALID_INPUT', '记忆最多 120 个字')
  return text
}

export function list(input: { source?: MemorySource } = {}): Memory[] {
  return memoryRepo.list({ source: input.source })
}

/** 手动添加：`source` 写死 `'manual'`。撞唯一索引 → 返回已有那条，不报错、不新增 */
export function addManual(input: { contentMd: string; kind: MemoryKind }): Memory {
  const contentMd = normalize(input.contentMd)
  const existing = memoryRepo.getByContent(contentMd)
  if (existing !== null) return existing
  if (memoryRepo.count() >= MEMORY_LIMIT) {
    throw appError('INVALID_INPUT', `记忆已达 ${MEMORY_LIMIT} 条，请先删几条`)
  }
  return memoryRepo.insert({ contentMd, kind: input.kind, source: 'manual' })
}

export function update(id: string, patch: { contentMd?: string; kind?: MemoryKind }): Memory {
  const next: memoryRepo.MemoryUpdate = {}
  if (patch.contentMd !== undefined) next.contentMd = normalize(patch.contentMd)
  if (patch.kind !== undefined) next.kind = patch.kind
  try {
    return memoryRepo.update(id, next)
  } catch (e) {
    // 改后的内容与另一条撞唯一索引：CONFLICT 不是给用户看的码，翻成契约里的 INVALID_INPUT
    if (e instanceof AppErrorException && e.code === 'CONFLICT') {
      throw appError('INVALID_INPUT', '这条记忆已经存在', { detail: e.detail })
    }
    throw e
  }
}

export function remove(id: string): void {
  memoryRepo.remove(id)
}

/** 这批记忆被拼进 system prompt 了：`hits + 1`（淘汰依据，不是展示字段） */
export function touchHits(ids: readonly string[]): void {
  memoryRepo.touchHits(ids)
}

/**
 * 自动提取落库（内部用，不挂 IPC）。满 50 条先淘汰一条（`hits` 最低 → 最久没碰），
 * 再 `INSERT OR IGNORE`。模型偶尔会给出空句或超长句：**跳过，不截断**——
 * 截断过的记忆比没有记忆更糟（后半句丢了，前半句变成假事实）。
 *
 * 返回 null = 这条没收（空串 / 超长 / 已存在）。调用方不需要区分。
 */
export function addAuto(input: { contentMd: string; kind: MemoryKind }): Memory | null {
  const text = input.contentMd.trim()
  const chars = charCount(text)
  if (chars === 0 || chars > MEMORY_MAX_CHARS) return null
  if (memoryRepo.count() >= MEMORY_LIMIT) memoryRepo.evictOne()
  const before = memoryRepo.getByContent(text)
  if (before !== null) return before
  return memoryRepo.insert({ contentMd: text, kind: input.kind, source: 'auto' })
}
