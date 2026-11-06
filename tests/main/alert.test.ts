import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as alertRepo from '../../src/main/db/repositories/alertRepo'
import { callTool } from '../../src/main/mcp/tools'
import * as alertService from '../../src/main/services/alertService'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/**
 * 提醒确认与外部升级（v0.88）。
 *
 * 不启动 `alertScheduler`（会留定时器），只测 service / repo 与 MCP 工具；
 * 需要历史 `firedAt` 的用例直接经 repo 插入，不 sleep、不改系统时间。
 */

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('提醒确认与外部升级', () => {
  it('record + listSince：两条都记下、确认与升级状态全空、按 firedAt 升序', () => {
    const now = new Date()
    alertRepo.insert({
      id: 'a-old',
      kind: 'reminder',
      level: 'normal',
      sourceId: 'r-old',
      title: '喝水',
      firedAt: new Date(now.getTime() - 5_000).toISOString()
    })
    const fresh = alertService.recordAlert({ level: 'strong', sourceId: 'r-new', title: '交报告' })

    const list = alertService.listSince(60_000, new Date())
    expect(list).toHaveLength(2)
    expect(list.map(item => item.id)).toEqual(['a-old', fresh.id])
    expect(list.every(item => item.ackedAt === null && item.escalatedAt === null)).toBe(true)
  })

  it('ack：命中返回 1、重复确认返回 0、sourceId 不存在也返回 0 且不抛错', () => {
    alertService.recordAlert({ level: 'normal', sourceId: 'r1', title: '喝水' })

    expect(alertService.ackAlert('r1')).toBe(1)
    expect(alertService.ackAlert('r1')).toBe(0)
    expect(alertService.ackAlert('没有这一条')).toBe(0)

    const [row] = alertRepo.listRecent(10)
    expect(row.ackedAt).not.toBeNull()
  })

  it('escalateDue · normal：11 秒前升级、9 秒前不动', () => {
    const now = new Date('2026-11-06T08:00:00.000Z')
    alertRepo.insert({
      id: 'n-old',
      kind: 'reminder',
      level: 'normal',
      sourceId: 'r-n-old',
      title: '喝水',
      firedAt: new Date(now.getTime() - 11_000).toISOString()
    })
    alertRepo.insert({
      id: 'n-new',
      kind: 'reminder',
      level: 'normal',
      sourceId: 'r-n-new',
      title: '起身',
      firedAt: new Date(now.getTime() - 9_000).toISOString()
    })

    expect(alertService.escalateDue(now)).toBe(1)
    const rows = alertRepo.listRecent(10)
    expect(rows.find(item => item.id === 'n-old')?.escalatedAt).toBe(now.toISOString())
    expect(rows.find(item => item.id === 'n-new')?.escalatedAt).toBeNull()
  })

  it('escalateDue · strong：59 秒前不动、61 秒前升级', () => {
    const now = new Date('2026-11-06T08:00:00.000Z')
    alertRepo.insert({
      id: 's-new',
      kind: 'reminder',
      level: 'strong',
      sourceId: 'r-s-new',
      title: '交报告',
      firedAt: new Date(now.getTime() - 59_000).toISOString()
    })
    alertRepo.insert({
      id: 's-old',
      kind: 'reminder',
      level: 'strong',
      sourceId: 'r-s-old',
      title: '开会',
      firedAt: new Date(now.getTime() - 61_000).toISOString()
    })

    expect(alertService.escalateDue(now)).toBe(1)
    const rows = alertRepo.listRecent(10)
    expect(rows.find(item => item.id === 's-new')?.escalatedAt).toBeNull()
    expect(rows.find(item => item.id === 's-old')?.escalatedAt).toBe(now.toISOString())
  })

  it('escalateDue 跳过已确认的行', () => {
    const now = new Date('2026-11-06T08:00:00.000Z')
    alertRepo.insert({
      id: 'acked',
      kind: 'reminder',
      level: 'normal',
      sourceId: 'r-acked',
      title: '喝水',
      firedAt: new Date(now.getTime() - 30_000).toISOString()
    })
    expect(alertService.ackAlert('r-acked')).toBe(1)

    expect(alertService.escalateDue(now)).toBe(0)
    const row = alertRepo.listRecent(1)[0]
    expect(row.ackedAt).not.toBeNull()
    expect(row.escalatedAt).toBeNull()
  })

  it('list_alerts：sinceMinutes 越界夹到 1440 不抛错，acked/escalated 是布尔、ageSeconds 非负整数', () => {
    alertService.recordAlert({ level: 'normal', sourceId: 'r-tool', title: '起身' })

    const out = callTool('list_alerts', { sinceMinutes: 99_999 }) as unknown as {
      now: string
      alerts: {
        sourceId: string
        acked: boolean
        escalated: boolean
        ageSeconds: number
      }[]
    }

    expect(typeof out.now).toBe('string')
    expect(out.now.length).toBeGreaterThan(0)

    const item = out.alerts.find(alert => alert.sourceId === 'r-tool')
    expect(item).toBeDefined()
    expect(item?.acked).toBe(false)
    expect(item?.escalated).toBe(false)
    expect(Number.isInteger(item?.ageSeconds)).toBe(true)
    expect(item?.ageSeconds).toBeGreaterThanOrEqual(0)
  })
})
