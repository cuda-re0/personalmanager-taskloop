import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/main/db/connection'
import { newId } from '../../src/main/db/ids'
import * as reminderRepo from '../../src/main/db/repositories/reminderRepo'
import * as taskRepo from '../../src/main/db/repositories/taskRepo'
import { nowIso } from '../../src/main/db/localDay'
import type { ReminderInsert } from '../../src/main/db/mappers'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

/**
 * `reminders` 是从 `tasks.reminder_offsets_json` 物化出来的，所以这组用例全部围绕
 * `replaceForTask()`（重建）与 `uq_reminder_task_offset`（谁占唯一位）展开。
 *
 * 核心约束（01 §2.5）：唯一索引的条件是 `status IN ('active','paused')`。
 * fired / failed 是历史、cancelled 已作废，都不占位——否则"同一偏移触发过一次后再 sync"会插不进去。
 */

const NOW = '2026-10-28T02:00:00.000Z'
const DUE = '2026-10-30T14:00:00.000Z'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

function makeTask(): string {
  return taskService.createTask({
    type: 'deadline',
    title: '交作业',
    dueAt: DUE,
    reminderOffsets: [-30, -10],
    reminderChannels: ['inapp']
  }).id
}

/** 按偏移造一条待插入行；fire_at 用偏移量算出来，方便断言重建后是新值 */
function row(taskId: string, offsetMin: number | null, minuteShift = 0): ReminderInsert {
  const base = Date.parse(DUE) + (offsetMin ?? 0) * 60_000 + minuteShift * 60_000
  return {
    id: newId(),
    taskId,
    occurrenceId: null,
    offsetMin,
    fireAt: new Date(base).toISOString(),
    channels: ['inapp'],
    createdAt: NOW
  }
}

describe('reminders 物化与唯一索引', () => {
  it('replaceForTask：首次按偏移建行，重复调用不增长', () => {
    const taskId = makeTask()

    const first = reminderRepo.replaceForTask(taskId, [row(taskId, -30), row(taskId, -10)])
    expect(first).toHaveLength(2)
    expect(first.map(r => r.offsetMin).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([-30, -10])
    expect(first.every(r => r.status === 'active')).toBe(true)

    // 同一批再 sync 一次：旧的 active 被删、新的插进来，总数不变
    const second = reminderRepo.replaceForTask(taskId, [row(taskId, -30), row(taskId, -10)])
    expect(second).toHaveLength(2)
    expect(reminderRepo.countAll()).toBe(2)
  })

  it('改 due_at 后再 sync：旧行被替换、fire_at 跟着变', () => {
    const taskId = makeTask()
    const before = reminderRepo.replaceForTask(taskId, [row(taskId, -30)])
    const beforeFireAt = before[0].fireAt

    const after = reminderRepo.replaceForTask(taskId, [row(taskId, -30, 60)])
    expect(after).toHaveLength(1)
    expect(after[0].fireAt).not.toBe(beforeFireAt)
    expect(reminderRepo.countAll()).toBe(1)
  })

  it('★ 同一偏移已 fired 后再 sync：能插入新 active，fired 行留作历史', () => {
    const taskId = makeTask()
    const [firedRow] = reminderRepo.replaceForTask(taskId, [row(taskId, -30)])
    reminderRepo.markFired(firedRow.id, ['inapp'], NOW)

    // 改 due_at 导致 fire_at 变化 → 重建。旧实现（status != 'cancelled'）在这里撞唯一索引
    const rebuilt = reminderRepo.replaceForTask(taskId, [row(taskId, -30, 120)])

    expect(rebuilt).toHaveLength(2)
    const active = rebuilt.filter(r => r.status === 'active')
    const fired = rebuilt.filter(r => r.status === 'fired')
    expect(active).toHaveLength(1)
    expect(fired).toHaveLength(1)
    expect(fired[0].id).toBe(firedRow.id)
    expect(fired[0].offsetMin).toBe(-30)
    expect(active[0].offsetMin).toBe(-30)
    expect(active[0].fireAt).not.toBe(fired[0].fireAt)
  })

  it('已 cancelled 的行不占唯一位', () => {
    const taskId = makeTask()
    const [cancelled] = reminderRepo.replaceForTask(taskId, [row(taskId, -10)])
    reminderRepo.cancel(cancelled.id)

    const rebuilt = reminderRepo.replaceForTask(taskId, [row(taskId, -10)])
    expect(rebuilt.filter(r => r.status === 'active')).toHaveLength(1)
    expect(rebuilt.filter(r => r.status === 'cancelled')).toHaveLength(1)
  })

  it('failed 行在重建时被清掉（docs/01 §2.5 的同步策略）', () => {
    const taskId = makeTask()
    const [failed] = reminderRepo.replaceForTask(taskId, [row(taskId, -10)])
    reminderRepo.markFailed(failed.id, 'smtp 超时')

    const rebuilt = reminderRepo.replaceForTask(taskId, [row(taskId, -10)])
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].status).toBe('active')
    expect(rebuilt.every(r => r.id !== failed.id)).toBe(true)
  })

  it('同一任务同一偏移的两条 active 会被库里拒掉（CONFLICT）', () => {
    const taskId = makeTask()
    const first = row(taskId, -30)
    reminderRepo.insert(first)

    expectErrorCode(() => reminderRepo.insert({ ...row(taskId, -30) }), 'CONFLICT')
    expect(reminderRepo.countAll()).toBe(1)
  })

  it('offset_min 为 NULL 的行不受唯一索引约束（绝对时间提醒）', () => {
    const taskId = makeTask()
    reminderRepo.insert(row(taskId, null))
    reminderRepo.insert(row(taskId, null, 5))

    const all = reminderRepo.listByTask(taskId)
    expect(all).toHaveLength(2)
    expect(all.every(r => r.offsetMin === null)).toBe(true)
  })

  it('markFired / cancel / snooze 的状态流转', () => {
    const taskId = makeTask()
    const [r] = reminderRepo.replaceForTask(taskId, [row(taskId, -30)])

    const fired = reminderRepo.markFired(r.id, ['inapp', 'mail'], NOW)
    expect(fired.status).toBe('fired')
    expect(fired.lastFiredAt).toBe(NOW)
    expect(fired.firedChannels).toEqual(['inapp', 'mail'])

    // 已 fired 的不能再取消
    expectErrorCode(() => reminderRepo.cancel(r.id), 'CONFLICT')

    // snooze 把它拉回 active，并改 fire_at
    const snoozed = reminderRepo.snooze(r.id, '2026-10-30T13:00:00.000Z')
    expect(snoozed.status).toBe('active')
    expect(snoozed.fireAt).toBe('2026-10-30T13:00:00.000Z')
  })

  it('listUpcoming / listDue 只看 active', () => {
    const taskId = makeTask()
    const rows = reminderRepo.replaceForTask(taskId, [row(taskId, -30), row(taskId, -10)])
    reminderRepo.markFired(rows[0].id, ['inapp'], NOW)

    expect(reminderRepo.listUpcoming()).toHaveLength(1)
    expect(reminderRepo.listDue('2030-01-01T00:00:00.000Z').every(r => r.status === 'active')).toBe(true)
    expect(reminderRepo.listDue('2030-01-01T00:00:00.000Z')).toHaveLength(1)
  })

  it('删任务时 reminders 走 ON DELETE CASCADE', () => {
    const taskId = makeTask()
    reminderRepo.replaceForTask(taskId, [row(taskId, -30)])
    expect(reminderRepo.countAll()).toBe(1)

    getDb().prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    expect(reminderRepo.countAll()).toBe(0)
  })

  it('ensureRepeatRows：时刻改动 → 旧时刻行全清、新行全落新时刻；同刻连调不重复（84 §3）', () => {
    const taskId = taskService.createTask({
      type: 'daily',
      title: '每天背单词',
      dailyTime: '09:00',
      repeatRule: 'EVERY:1:D'
    }).id
    const rule = 'EVERY:1:D'
    const days = ['2026-11-10', '2026-11-11', '2026-11-12']
    // 本地时刻构串，绝不经过 UTC 解析——断言与造数据都只看本地分量
    const localIso = (day: string, hour: number): string =>
      new Date(
        Number(day.slice(0, 4)),
        Number(day.slice(5, 7)) - 1,
        Number(day.slice(8, 10)),
        hour,
        0,
        0,
        0
      ).toISOString()
    const rowsAt = (hour: number): Omit<ReminderInsert, 'taskId'>[] =>
      days.map(day => ({
        id: newId(),
        occurrenceId: null,
        offsetMin: null,
        fireAt: localIso(day, hour),
        repeatRule: rule,
        channels: ['inapp'],
        level: 'normal',
        status: 'active',
        createdAt: NOW
      }))
    const activeAbsolute = () =>
      reminderRepo.listByTask(taskId).filter(r => r.offsetMin === null && r.status === 'active')

    reminderRepo.ensureRepeatRows(taskId, rule, '09:00', rowsAt(9))
    expect(activeAbsolute()).toHaveLength(3)

    reminderRepo.ensureRepeatRows(taskId, rule, '21:00', rowsAt(21))
    const after = activeAbsolute()
    expect(after).toHaveLength(3)
    expect(
      after.every(r => {
        const at = new Date(r.fireAt)
        return at.getHours() === 21 && at.getMinutes() === 0
      })
    ).toBe(true)

    // 同一 clock 连续调两次：行数不变（正常补建不重复插入、也不误删）
    reminderRepo.ensureRepeatRows(taskId, rule, '21:00', rowsAt(21))
    expect(activeAbsolute()).toHaveLength(3)
  })
})

describe('删除任务的提醒收尾（v0.85b）', () => {
  it('删除任务后 active 清空、fired 保留', () => {
    const taskId = makeTask()
    reminderRepo.insert(row(taskId, -30))
    reminderRepo.insert(row(taskId, -10))
    const third = reminderRepo.insert(row(taskId, -20))
    reminderRepo.markFired(third.id, ['inapp'], NOW)

    taskService.removeTask(taskId)

    const left = reminderRepo.listByTask(taskId)
    expect(left).toHaveLength(1)
    expect(left[0].status).toBe('fired')
    expect(
      reminderRepo.listDue('2099-01-01T00:00:00.000Z').some(r => r.taskId === taskId)
    ).toBe(false)
  })

  it('purgeForInactiveTasks 只清已删任务的行，且幂等', () => {
    const alive = makeTask()
    const dead = makeTask()
    reminderRepo.insert(row(alive, -30))
    reminderRepo.insert(row(dead, -30))

    // 不用 removeTask：它会直接删行，测不到 purge
    taskRepo.updateColumns(dead, { status: 'discarded' }, nowIso())

    expect(reminderRepo.purgeForInactiveTasks()).toBe(1)
    expect(reminderRepo.listByTask(alive)).toHaveLength(1)
    expect(reminderRepo.listByTask(dead)).toHaveLength(0)
    expect(reminderRepo.purgeForInactiveTasks()).toBe(0)
  })
})
