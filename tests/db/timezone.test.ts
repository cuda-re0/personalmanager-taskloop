import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/main/db/connection'
import { isoToLocalDay, isoToLocalTime, toLocalDay } from '../../src/main/db/localDay'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
import * as pointsService from '../../src/main/services/pointsService'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, openMemoryDb } from './helpers'

/**
 * 时区陷阱（01 §4.1 + 验收条款「东八区 00:30 写入，day 落在当天」）。
 *
 * 这里用显式 timeZone='Asia/Shanghai' 断言，而不是依赖跑测试那台机器的 TZ——
 * 逻辑本身（Intl + 显式时区）与机器时区无关，机器是 UTC 也照样绿。
 * 另有一条用例校验"我们的 JS 算法"与"SQL 的 date(...,'localtime')"在**系统时区**下一致。
 */

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('本地日历日', () => {
  it('东八区 00:30 写入落在当天，不是前一天', () => {
    // 2026-10-28 00:30 +08:00 == 2026-10-27T16:30:00Z
    const instant = new Date('2026-10-27T16:30:00.000Z')
    expect(toLocalDay(instant, 'Asia/Shanghai')).toBe('2026-10-28')
    // 对照：UTC 日期会退到前一天，这正是不能用 toISOString().slice(0,10) 的原因
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-27')
    // 对照：SQLite 的 date() 不带 localtime 也是 UTC
    const sqlUtc = getDb().prepare("SELECT date(?) AS d").get(instant.toISOString()) as { d: string }
    expect(sqlUtc.d).toBe('2026-10-27')
  })

  it('东八区 23:59 仍在当天，UTC 23:30 才是次日 07:30', () => {
    expect(toLocalDay(new Date('2026-10-28T15:59:00.000Z'), 'Asia/Shanghai')).toBe('2026-10-28')
    expect(toLocalDay(new Date('2026-10-27T23:30:00.000Z'), 'Asia/Shanghai')).toBe('2026-10-28')
    // 同一瞬间在 UTC 是 10-27
    expect(new Date('2026-10-27T23:30:00.000Z').toISOString().slice(0, 10)).toBe('2026-10-27')
  })

  it('本地时刻 HH:mm 也按本地时区算', () => {
    expect(isoToLocalTime('2026-10-27T16:30:00.000Z', 'Asia/Shanghai')).toBe('00:30')
    expect(isoToLocalTime('2026-10-27T23:30:00.000Z', 'Asia/Shanghai')).toBe('07:30')
    // 东八区不存在 24:00 这种输出（hourCycle=h23）
    expect(isoToLocalTime('2026-10-27T16:00:00.000Z', 'Asia/Shanghai')).toBe('00:00')
  })

  it('JS 算法与 SQL 的 date(...,"localtime") 在系统时区下一致', () => {
    const db = getDb()
    const instants = [
      '2026-10-27T16:30:00.000Z',
      '2026-10-27T15:59:59.000Z',
      '2026-10-28T00:00:00.000Z',
      '2026-12-31T16:00:00.000Z'
    ]
    for (const iso of instants) {
      const sqlDay = (db.prepare("SELECT date(?, 'localtime') AS d").get(iso) as { d: string }).d
      expect(isoToLocalDay(iso)).toBe(sqlDay)
    }
  })

  it('流水按本地日聚合：00:30 那一笔算今天的，不算昨天', () => {
    // 走真实写入路径：day 由 isoToLocalDay 算好后写入
    const day = isoToLocalDay('2026-10-27T16:30:00.000Z', 'Asia/Shanghai')
    expect(day).toBe('2026-10-28')

    pointsService.award({
      taskId: null,
      delta: 12.5,
      kind: 'adjust',
      reasonCode: 'manual_adjust',
      day
    })

    expect(ledgerRepo.sumByDay('2026-10-28')).toBe(12.5)
    expect(ledgerRepo.sumByDay('2026-10-27')).toBe(0)
    expect(statsRepo.getDay('2026-10-28').points).toBe(12.5)
    expect(statsRepo.monthStats(2026, 10).map(d => d.day)).toContain('2026-10-28')
  })

  it('日历红点与本地日一致（同一时刻不会落到前一天）', () => {
    const instant = '2026-10-27T16:30:00.000Z' // 本地 10-28 00:30
    const localDay = isoToLocalDay(instant)
    taskService.createTask({ type: 'deadline', title: '零点交的作业', dueAt: instant })

    const hits = statsRepo.dayIndex(localDay, localDay)
    expect(hits).toHaveLength(1)
    expect(hits[0].day).toBe(localDay)
    expect(hits[0].total).toBe(1)

    // 系统时区是东八区时，本地日必须正好是 10-28
    if (new Date().getTimezoneOffset() === -480) {
      expect(localDay).toBe('2026-10-28')
      expect(statsRepo.dayIndex('2026-10-27', '2026-10-27')).toHaveLength(0)
    }
  })
})
