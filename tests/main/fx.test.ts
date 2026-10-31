import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../../src/main/db/ids'
import { addDays, nowIso, todayLocalDay } from '../../src/main/db/localDay'
import * as fxRepo from '../../src/main/db/repositories/fxRepo'
import * as statsRepo from '../../src/main/db/repositories/statsRepo'
import * as aiService from '../../src/main/services/aiService'
import * as fxService from '../../src/main/services/fxService'
import { scriptedProvider } from '../ai/helpers'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/**
 * 汇率评估（45 §10 第二组）。
 *
 * 六条锁的都是"钱怎么变"的规矩：本周已有记录就不动、越界要钳、失败沿用上期
 * （不许回落 1.0）、没数据不烧 token、一条记录都没有也能记账。
 */

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

const WEEK_START = fxService.weekStartOf(todayLocalDay())
const LAST_FROM = addDays(WEEK_START, -7)

/** 上周有一点可看的数据：有了它才会走 AI 评估 */
function seedLastWeek(): void {
  statsRepo.addPoints(LAST_FROM, 12)
  statsRepo.bumpTasksDone(LAST_FROM, 1)
}

/** 在指定周写一条汇率（模拟"上期"） */
function seedRate(weekStart: string, rate: number): void {
  fxRepo.insert({ id: newId(), weekStart, rate, source: 'ai', createdAt: nowIso() })
}

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  aiService.resetForTest()
  closeTestDb()
})

describe('ensureWeek：幂等与评估时机', () => {
  it('本周已有记录 → 什么都不做，不调 AI', async () => {
    seedRate(WEEK_START, 1.05)
    const provider = scriptedProvider([() => ({ rate: 1.1, reason: 'x' })])
    aiService.setProvider(provider)

    const row = await fxService.ensureWeek()

    expect(provider.calls).toBe(0)
    expect(row.rate).toBe(1.05)
    expect(fxRepo.latest()?.rate).toBe(1.05)
  })

  it('上周没有任何数据 → 不调 AI，写 fallback', async () => {
    const provider = scriptedProvider([() => ({ rate: 1.15, reason: 'x' })])
    aiService.setProvider(provider)

    const row = await fxService.ensureWeek()

    expect(provider.calls).toBe(0)
    expect(row.source).toBe('fallback')
    expect(row.rate).toBe(1)
  })

  it('未配置 key → 不调 AI，写 fallback 且沿用上期', async () => {
    seedRate(addDays(WEEK_START, -7), 0.9)
    seedLastWeek()
    aiService.setKeyProbe(() => false)

    const row = await fxService.ensureWeek()

    expect(row.source).toBe('fallback')
    expect(row.rate).toBe(0.9)
  })
})

describe('ensureWeek：AI 结果钳制', () => {
  it('返回 2.0 → 1.15', async () => {
    seedLastWeek()
    aiService.setProvider(scriptedProvider([() => ({ rate: 2.0, reason: '太乐观' })]))

    const row = await fxService.ensureWeek()
    expect(row.source).toBe('ai')
    expect(row.rate).toBe(1.15)
  })

  it('返回 0.5 → 0.85', async () => {
    seedLastWeek()
    aiService.setProvider(scriptedProvider([() => ({ rate: 0.5, reason: '太悲观' })]))

    const row = await fxService.ensureWeek()
    expect(row.rate).toBe(0.85)
  })

  it('返回 NaN → 当作评估失败，走 fallback', async () => {
    seedLastWeek()
    aiService.setProvider(scriptedProvider([() => ({ rate: Number.NaN, reason: '坏了' })]))

    const row = await fxService.ensureWeek()
    expect(row.source).toBe('fallback')
    expect(row.rate).toBe(1)
  })
})

describe('ensureWeek：不做相对上期的平滑', () => {
  it('上期 0.9、AI 给 1.15 → 本期就是 1.15', async () => {
    seedRate(addDays(WEEK_START, -7), 0.9)
    seedLastWeek()
    aiService.setProvider(scriptedProvider([() => ({ rate: 1.15, reason: '上周很好' })]))

    const row = await fxService.ensureWeek()
    expect(row.rate).toBe(1.15)
  })

  it('上期 1.1、AI 给 0.85 → 本期就是 0.85', async () => {
    seedRate(addDays(WEEK_START, -7), 1.1)
    seedLastWeek()
    aiService.setProvider(scriptedProvider([() => ({ rate: 0.85, reason: '上周很糟' })]))

    const row = await fxService.ensureWeek()
    expect(row.rate).toBe(0.85)
  })
})

describe('currentRate：永不抛错', () => {
  it('一条记录都没有 → rate 1，weekStart 是本周一', () => {
    expect(() => fxService.currentRate()).not.toThrow()
    expect(fxService.currentRate()).toEqual({ rate: 1, weekStart: WEEK_START })
  })
})
