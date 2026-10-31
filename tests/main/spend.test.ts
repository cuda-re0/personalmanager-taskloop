import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '../../src/main/db/ids'
import { nowIso, todayLocalDay } from '../../src/main/db/localDay'
import * as fxRepo from '../../src/main/db/repositories/fxRepo'
import * as ledgerRepo from '../../src/main/db/repositories/ledgerRepo'
import { weekStartOf } from '../../src/main/services/fxService'
import * as pointsService from '../../src/main/services/pointsService'
import { closeTestDb, expectErrorCode, openMemoryDb } from '../db/helpers'

/**
 * 零花钱支出（45 §10 第一组）。
 *
 * 四个用例锁公式、三个用例锁"账能纠错"：取整只走 `roundPoints`（两位小数），
 * 撤销不删流水而是写反向行，余额回到记账前。
 */

/** 把本期汇率钉死到指定值，公式才可断言 */
function setRate(rate: number): void {
  fxRepo.insert({
    id: newId(),
    weekStart: weekStartOf(todayLocalDay()),
    rate,
    source: 'fallback',
    createdAt: nowIso()
  })
}

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('spend：金额 → 扣分', () => {
  it('rate=1 花 12.50 元 → -12.5 分，快照与金额都落库', () => {
    setRate(1)
    const entry = pointsService.spend({ amountCents: 1250, note: '早餐' })

    expect(entry.delta).toBe(-12.5)
    expect(entry.amountCents).toBe(1250)
    expect(entry.fxRate).toBe(1)
    expect(entry.kind).toBe('spend')
    expect(entry.reasonCode).toBe('pocket_spend')
    expect(entry.reasonText).toBe('早餐')
    expect(pointsService.balance()).toBe(-12.5)
  })

  it('rate=1.08 花 100 元 → -92.59（收敛两位，不许四舍五入到 -92.6）', () => {
    setRate(1.08)
    const entry = pointsService.spend({ amountCents: 10000 })
    expect(entry.delta).toBe(-92.59)
  })

  it('rate=0.85 花 100 元 → -117.65', () => {
    setRate(0.85)
    const entry = pointsService.spend({ amountCents: 10000 })
    expect(entry.delta).toBe(-117.65)
  })
})

describe('spend：入参校验', () => {
  it('0 / 负数 / 超单笔上限都报 INVALID_INPUT，且库里不多一行', () => {
    setRate(1)
    const before = ledgerRepo.countAll()

    for (const amountCents of [0, -100, 100001]) {
      expectErrorCode(() => pointsService.spend({ amountCents }), 'INVALID_INPUT')
    }

    expect(ledgerRepo.countAll()).toBe(before)
    expect(pointsService.balance()).toBe(0)
  })
})

describe('spendUndo：撤销一笔', () => {
  it('原行打上 reversedAt、反向行抵掉、余额回到记账前', () => {
    setRate(1)
    const entry = pointsService.spend({ amountCents: 1250 })
    expect(pointsService.balance()).toBe(-12.5)

    const reverse = pointsService.spendUndo(entry.id)

    expect(ledgerRepo.byId(entry.id)?.reversedAt).not.toBeNull()
    expect(reverse.delta).toBe(-entry.delta)
    expect(reverse.delta).toBe(12.5)
    expect(pointsService.balance()).toBe(0)
  })

  it('同一笔撤销两次 → CONFLICT，余额不再变', () => {
    setRate(1)
    const entry = pointsService.spend({ amountCents: 1250 })
    pointsService.spendUndo(entry.id)

    expectErrorCode(() => pointsService.spendUndo(entry.id), 'CONFLICT')
    expect(pointsService.balance()).toBe(0)
  })
})

describe('spendMonth：本月合计只算未撤销的支出', () => {
  it('撤掉一笔之后，合计与列表都不再包含它', () => {
    setRate(1)
    const keep = pointsService.spend({ amountCents: 1250, note: '早餐' })
    const undo = pointsService.spend({ amountCents: 3800, note: '打车' })

    pointsService.spendUndo(undo.id)

    const month = pointsService.spendMonth()
    expect(month.totalCents).toBe(1250)
    expect(month.entries.map(e => e.id)).toEqual([keep.id])
    // 汇率透传的是当期值，不在渲染层现算
    expect(month.rate).toBe(1)
    expect(month.weekStart).toBe(weekStartOf(todayLocalDay()))
  })
})
