import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/main/db/connection'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

/**
 * 拖拽排序（01 §2.1 sort_key）。
 *
 * 契约 v0.10 P1-6 的坑：间隔耗尽时的重编号只覆盖 `[prev, before, ...]`，漏掉前面的兄弟，
 * prev 拿到 1024 与残留键相撞；再按老的 index 算中值，被拖的任务会落到 before **后面**。
 */

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

function create(title: string): string {
  return taskService.createTask({ type: 'deadline', title }).id
}

/** 列表顺序（标题），listTasks 走 ORDER BY sort_key, created_at */
function order(): string[] {
  return taskService.listTasks().map(t => t.title)
}

/** 同级任务的 sort_key 必须严格递增且无重复——有重复就会退化成按 created_at 排 */
function assertStrictlyIncreasing(): void {
  const list = taskService.listTasks()
  const keys = list.map(t => t.sortKey)
  for (let i = 1; i < keys.length; i += 1) {
    expect(keys[i]).toBeGreaterThan(keys[i - 1])
  }
  expect(new Set(keys).size).toBe(keys.length)
}

describe('拖拽排序 sort_key', () => {
  it('间隔耗尽后整段重编号：拖到 C 之前必须真的排在 C 前面（P1-6）', () => {
    create('A')
    const b = create('B')
    const c = create('C')
    const d = create('D')

    // 把 B 与 C 的键压到相差 0.0005（多次中值插入后的真实形态），触发重编号分支
    const db = getDb()
    db.prepare('UPDATE tasks SET sort_key = 2048 WHERE id = ?').run(b)
    db.prepare('UPDATE tasks SET sort_key = 2048.0005 WHERE id = ?').run(c)
    db.prepare('UPDATE tasks SET sort_key = 4096 WHERE id = ?').run(d)

    taskService.reorderTask(d, c)

    // 旧实现在这里会把 D 算到 C 之后（newKey 用的是重编号前的 index）
    expect(order()).toEqual(['A', 'B', 'D', 'C'])
    assertStrictlyIncreasing()
    // A 的键不能被重排覆盖掉（旧实现漏掉 list_[0]，prev 拿到 1024 与 A 相撞）
    expect(order()[0]).toBe('A')
  })

  it('同一位置连续插入 25 次：每次整段严格递增，顺序与插入顺序一致', () => {
    create('锚点-首')
    const target = create('锚点-尾')
    const expected: string[] = ['锚点-首']

    // 每次新建都追加到末尾，再拖到 target 之前 —— 相当于反复插在同一处，
    // 间隙每次减半（1024 → 0.25 需 12 次，< 0.001 需 20 次），中途必然跨过重编号分支
    for (let i = 0; i < 25; i += 1) {
      const id = create(`插入-${String(i).padStart(2, '0')}`)
      taskService.reorderTask(id, target)
      expected.push(`插入-${String(i).padStart(2, '0')}`)

      expect(order()).toEqual([...expected, '锚点-尾'])
      assertStrictlyIncreasing()
    }
  })

  it('拖到最前 / 拖到末尾都保持严格递增', () => {
    const a = create('A')
    const b = create('B')
    const c = create('C')

    taskService.reorderTask(c, a) // C 到最前
    expect(order()).toEqual(['C', 'A', 'B'])
    assertStrictlyIncreasing()

    taskService.reorderTask(c, null) // 放到末尾
    expect(order()).toEqual(['A', 'B', 'C'])
    assertStrictlyIncreasing()

    taskService.reorderTask(a, b) // A 到 B 之前（已经在位）
    expect(order()).toEqual(['A', 'B', 'C'])
    assertStrictlyIncreasing()
  })

  it('参照任务不存在 / 不同层级 → NOT_FOUND，且不动任何键', () => {
    const a = create('A')
    const parent = create('父')
    const child = taskService.createTask({ type: 'deadline', title: '子', parentId: parent }).id
    expectErrorCode(() => taskService.reorderTask(a, 'no-such-id'), 'NOT_FOUND')
    expectErrorCode(() => taskService.reorderTask(a, child), 'NOT_FOUND')
    expect(order()).toContain('A')
  })
})
