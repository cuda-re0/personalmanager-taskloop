import type { Evidence, Task, TaskPatch, TaskStatus, TaskType } from '../../../shared/types/domain'
import { getDb, tx } from '../connection'
import { appError, wrapWriteError } from '../errors'
import {
  TASK_COLUMNS,
  TASK_INSERT_COLUMNS,
  mapTask,
  taskInsertParams,
  taskPatchToColumns
} from '../mappers'
import type { SqlValue, TaskInsert, TaskRow } from '../mappers'
import { buildSetClause, placeholders } from '../sqlUtil'

/**
 * tasks 的数据访问层。只有 SQL 与行映射，不含业务编排（积分、证据闸门、AI 都在上层）。
 */

const SELECT_TASK = `SELECT ${TASK_COLUMNS.join(', ')} FROM tasks`

export interface ListTasksOptions {
  /** 不给就默认 `todo|doing|reviewing`（discarded / archived 列表默认过滤，01 §3） */
  status?: TaskStatus[]
  types?: TaskType[]
  /** false/undefined：只返回顶层任务（parent_id IS NULL）；true：子任务也一起返回 */
  includeSubtasks?: boolean
  parentId?: string | null
  limit?: number
}

export function insert(input: TaskInsert): Task {
  const columns = TASK_INSERT_COLUMNS.join(', ')
  const sql = `INSERT INTO tasks (${columns}) VALUES (${placeholders(TASK_INSERT_COLUMNS.length)})`
  try {
    getDb()
      .prepare(sql)
      .run(...taskInsertParams(input))
  } catch (e) {
    throw wrapWriteError(e, '任务写入失败（id 重复或父任务不存在）')
  }
  return requireById(input.id)
}

export function getById(id: string): Task | null {
  const row = getDb().prepare(`${SELECT_TASK} WHERE id = ?`).get(id) as TaskRow | undefined
  return row ? mapTask(row) : null
}

export function requireById(id: string): Task {
  const task = getById(id)
  if (!task) throw appError('NOT_FOUND', '任务不存在', { detail: `id=${id}` })
  return task
}

export function list(options: ListTasksOptions = {}): Task[] {
  // 默认「活跃」集合（v0.38 加 pending_review：待提交也是活任务，不在列表里就等于消失）
  const statuses = options.status ?? ['todo', 'doing', 'pending_review', 'reviewing']
  if (statuses.length === 0) return []

  const where: string[] = [`status IN (${placeholders(statuses.length)})`]
  const params: SqlValue[] = [...statuses]

  if (options.types && options.types.length > 0) {
    where.push(`type IN (${placeholders(options.types.length)})`)
    params.push(...options.types)
  }

  if (options.parentId !== undefined) {
    if (options.parentId === null) {
      where.push('parent_id IS NULL')
    } else {
      where.push('parent_id = ?')
      params.push(options.parentId)
    }
  } else if (options.includeSubtasks !== true) {
    where.push('parent_id IS NULL')
  }

  let sql = `${SELECT_TASK} WHERE ${where.join(' AND ')} ORDER BY sort_key ASC, created_at ASC`
  if (options.limit !== undefined) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  return (getDb().prepare(sql).all(...params) as TaskRow[]).map(mapTask)
}

export function listSubtasks(parentId: string): Task[] {
  return (getDb()
    .prepare(`${SELECT_TASK} WHERE parent_id = ? ORDER BY sort_key ASC, created_at ASC`)
    .all(parentId) as TaskRow[]).map(mapTask)
}

/** occurrence 生成只看这批任务（01 §2.1.3：daily 且 todo/doing）。排除子任务：
 *  子步骤若与父任务同为 daily，会各自被 ensureRange 生成 occurrence、污染 streak（W5 交付报告上报，v0.15 修复） */
export function listDailyActive(): Task[] {
  return (getDb()
    .prepare(`${SELECT_TASK} WHERE type = 'daily' AND status IN ('todo','doing') AND parent_id IS NULL ORDER BY sort_key ASC`)
    .all() as TaskRow[]).map(mapTask)
}

/** 按列名直接改（status / points_awarded 等内部字段用它，不进 TaskPatch） */
export function updateColumns(id: string, columns: Record<string, SqlValue>, updatedAt: string): Task {
  const cols = { ...columns, updated_at: updatedAt }
  const { clause, values } = buildSetClause(cols)
  const changes = getDb()
    .prepare(`UPDATE tasks SET ${clause} WHERE id = ?`)
    .run(...values, id).changes
  if (changes === 0) throw appError('NOT_FOUND', '任务不存在', { detail: `id=${id}` })
  return requireById(id)
}

export function update(id: string, patch: TaskPatch, updatedAt: string): Task {
  const cols = taskPatchToColumns(patch)
  if (Object.keys(cols).length === 0) return requireById(id)
  return updateColumns(id, cols, updatedAt)
}

export function setRequiresEvidence(id: string, value: boolean, updatedAt: string): Task {
  return updateColumns(id, { requires_evidence: value ? 1 : 0 }, updatedAt)
}

/** 追加一条证据；保留原有证据（审核来回"先追问再补"要能累积，02 §3.2） */
export function appendEvidence(id: string, evidence: Evidence, updatedAt: string): Task {
  const task = requireById(id)
  const next = [...task.evidence, evidence]
  return updateColumns(id, { evidence_json: JSON.stringify(next) }, updatedAt)
}

export function replaceEvidence(id: string, evidence: Evidence[], updatedAt: string): Task {
  if (evidence.length === 0) throw appError('INVALID_INPUT', '证据不能为空')
  return updateColumns(id, { evidence_json: JSON.stringify(evidence) }, updatedAt)
}

/**
 * 按下标删掉一条证据（v0.61，待提交卡上的 ×）。
 *
 * 与 `replaceEvidence` 的两点不同：**允许删成空数组**（用户清空重选是正常动作，
 * 空证据的后果由卡片自己承担——`[提交]` 回到禁用态），越界由这里挡成 `INVALID_INPUT`。
 */
export function removeEvidenceAt(id: string, index: number, updatedAt: string): Task {
  const task = requireById(id)
  if (index >= task.evidence.length) throw appError('INVALID_INPUT', '证据下标越界')
  const next = task.evidence.filter((_, i) => i !== index)
  return updateColumns(id, { evidence_json: JSON.stringify(next) }, updatedAt)
}

/** 软删 → discarded（02 §3.2 task.remove）。不做物理删除，流水与统计才解释得通。 */
export function softRemove(id: string, updatedAt: string): void {
  const changes = getDb()
    .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run('discarded', updatedAt, id).changes
  if (changes === 0) throw appError('NOT_FOUND', '任务不存在', { detail: `id=${id}` })
}

/**
 * 物理删除。契约里的 `task.remove` 走 `softRemove`（→ discarded）；
 * 这个函数只用于「彻底删除」以及验证外键级联（子任务/occurrence 级联删、ledger.task_id 置 NULL）。
 */
export function hardDelete(id: string): void {
  const changes = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id).changes
  if (changes === 0) throw appError('NOT_FOUND', '任务不存在', { detail: `id=${id}` })
}

function siblings(parentId: string | null, excludeId: string): Task[] {
  const sql =
    parentId === null
      ? `${SELECT_TASK} WHERE parent_id IS NULL AND id != ? ORDER BY sort_key ASC`
      : `${SELECT_TASK} WHERE parent_id = ? AND id != ? ORDER BY sort_key ASC`
  const params = parentId === null ? [excludeId] : [parentId, excludeId]
  return (getDb().prepare(sql).all(...params) as TaskRow[]).map(mapTask)
}

/**
 * 拖拽排序：把 id 放到 beforeId 之前（beforeId=null 表示放到末尾）。
 * 取邻居 sort_key 的中值，避免每次都重排全表（01 §2.1 的 sort_key 注释）。
 */
export function reorder(id: string, beforeId: string | null, updatedAt: string): void {
  const task = requireById(id)
  if (beforeId === id) return

  tx(() => {
    const list_ = siblings(task.parentId, id)
    let newKey: number

    if (beforeId === null) {
      const last = list_[list_.length - 1]
      newKey = last ? last.sortKey + 1024 : 1024
    } else {
      const index = list_.findIndex(t => t.id === beforeId)
      if (index === -1) throw appError('NOT_FOUND', '参照任务不存在或不在同一层级', { detail: beforeId })
      const before = list_[index]
      const prev = index > 0 ? list_[index - 1] : null
      if (prev) {
        const gap = before.sortKey - prev.sortKey
        if (gap < 0.001) {
          // 间隔耗尽：**整段**同级列表从 2048 起按 1024 重新编号（1024 空出来给"插到最前"）。
          // 不能只重排 [prev, before, ...]：那样前面的兄弟还留着旧键，prev 拿到 1024 会与之相撞，
          // 而 ORDER BY sort_key, created_at 会让拖拽结果按创建时间排（契约 v0.10 P1-6）。
          list_.forEach((t, i) => {
            getDb()
              .prepare('UPDATE tasks SET sort_key = ? WHERE id = ?')
              .run((i + 2) * 1024, t.id)
          })
          // 重编号后取「before 前面那个空槽」与 before 的中点
          const beforeKey = (index + 2) * 1024
          newKey = beforeKey - 512
        } else {
          newKey = (prev.sortKey + before.sortKey) / 2
        }
      } else {
        newKey = before.sortKey - 1024
      }
    }

    getDb()
      .prepare('UPDATE tasks SET sort_key = ?, updated_at = ? WHERE id = ?')
      .run(newKey, updatedAt, id)
  })
}

/** 新建任务时排到同级末尾 */
export function nextSortKey(parentId: string | null): number {
  const row =
    parentId === null
      ? (getDb().prepare('SELECT MAX(sort_key) AS k FROM tasks WHERE parent_id IS NULL').get() as {
          k: number | null
        })
      : (getDb().prepare('SELECT MAX(sort_key) AS k FROM tasks WHERE parent_id = ?').get(parentId) as {
          k: number | null
        })
  return (row.k ?? 0) + 1024
}

export function countAll(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }
  return row.n
}
