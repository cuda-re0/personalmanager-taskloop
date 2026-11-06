import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Pulse } from '../../src/shared/types/domain'
import { AppErrorException } from '../../src/main/db/errors'
import * as pulseRepo from '../../src/main/db/repositories/pulseRepo'
import * as pulseService from '../../src/main/services/pulseService'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/** 本地 12:00：用本地构造器，避免 UTC 系列方法把窗口判定整体偏移 */
const NOW = new Date(2026, 10, 6, 12, 0, 0)

function pulse(patch: Partial<Pulse> = {}): Pulse {
  return {
    id: 'p1',
    title: '喝水',
    intervalMinutes: 30,
    windowStart: null,
    windowEnd: null,
    enabled: true,
    lastFiredAt: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
    ...patch
  }
}

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('高频周期提醒', () => {
  it('inWindow：普通区间左闭右开、跨午夜并集、两个 null 与 start===end 都是全天', () => {
    expect(pulseService.inWindow('12:00', '09:00', '18:00')).toBe(true)
    expect(pulseService.inWindow('18:00', '09:00', '18:00')).toBe(false)
    expect(pulseService.inWindow('08:59', '09:00', '18:00')).toBe(false)
    expect(pulseService.inWindow('23:30', '22:00', '06:00')).toBe(true)
    expect(pulseService.inWindow('02:00', '22:00', '06:00')).toBe(true)
    expect(pulseService.inWindow('12:00', '22:00', '06:00')).toBe(false)
    expect(pulseService.inWindow('03:00', null, null)).toBe(true)
    expect(pulseService.inWindow('03:00', '09:00', '09:00')).toBe(true)
  })

  it('isDue：停用 / 窗口外 / 间隔未到 / 到期，以及 resetLastFired 之后启动不补发', () => {
    expect(pulseService.isDue(pulse({ enabled: false }), NOW)).toBe(false)
    expect(
      pulseService.isDue(pulse({ windowStart: '09:00', windowEnd: '10:00' }), NOW)
    ).toBe(false)
    expect(pulseService.isDue(pulse(), NOW)).toBe(true)
    expect(
      pulseService.isDue(
        pulse({ lastFiredAt: new Date(NOW.getTime() - 60_000).toISOString() }),
        NOW
      )
    ).toBe(false)
    expect(
      pulseService.isDue(
        pulse({ lastFiredAt: new Date(NOW.getTime() - 31 * 60_000).toISOString() }),
        NOW
      )
    ).toBe(true)

    const created = pulseService.create({ title: '起身', intervalMinutes: 30 })
    expect(pulseService.isDue(created, NOW)).toBe(true)
    pulseRepo.resetLastFired(NOW.toISOString())
    expect(pulseService.isDue(pulseRepo.requireById(created.id), NOW)).toBe(false)
  })

  it('create → list：取得到，enabled 是 boolean true（不是 1），lastFiredAt 是 null', () => {
    const created = pulseService.create({ title: '  喝水  ', intervalMinutes: 20 })
    const list = pulseService.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(created.id)
    expect(list[0].title).toBe('喝水')
    expect(list[0].enabled).toBe(true)
    expect(list[0].lastFiredAt).toBe(null)
  })

  it('setEnabled(id, false)：该项停用，列表仍只有这一条', () => {
    const created = pulseService.create({ title: '喝水', intervalMinutes: 30 })
    expect(pulseService.setEnabled(created.id, false).enabled).toBe(false)
    const list = pulseService.list()
    expect(list).toHaveLength(1)
    expect(list[0].enabled).toBe(false)
  })

  it('remove：列表清空，再删同一个 id 抛 AppErrorException', () => {
    const created = pulseService.create({ title: '喝水', intervalMinutes: 30 })
    pulseService.remove(created.id)
    expect(pulseService.list()).toEqual([])
    expect(() => pulseService.remove(created.id)).toThrow(AppErrorException)
  })

  it('create 校验：空标题 / 间隔 0 / 间隔 1441 / 只填一个窗口时间各抛 AppErrorException', () => {
    expect(() => pulseService.create({ title: '   ', intervalMinutes: 30 })).toThrow(
      AppErrorException
    )
    expect(() => pulseService.create({ title: '喝水', intervalMinutes: 0 })).toThrow(
      AppErrorException
    )
    expect(() => pulseService.create({ title: '喝水', intervalMinutes: 1441 })).toThrow(
      AppErrorException
    )
    expect(() =>
      pulseService.create({ title: '喝水', intervalMinutes: 30, windowStart: '09:00' })
    ).toThrow(AppErrorException)
  })
})
