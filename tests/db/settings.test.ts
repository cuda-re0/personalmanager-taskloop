import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '../../src/main/db/connection'
import { DEFAULT_SETTINGS, SETTING_KEYS } from '../../src/main/db/defaultSettings'
import type { AppSettings } from '../../src/shared/types/ipc'
import * as settingRepo from '../../src/main/db/repositories/settingRepo'
import { closeTestDb, expectErrorCode, openMemoryDb } from './helpers'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('settings', () => {
  it('空表时 getAll 返回 AppSettings 全量 14 个 key（不返回 undefined）', () => {
    const all = settingRepo.getAll()
    expect(Object.keys(all)).toHaveLength(14)
    expect(Object.keys(all).sort()).toEqual([...SETTING_KEYS].sort())
    expect(all).toEqual(DEFAULT_SETTINGS)
    expect(SETTING_KEYS).not.toContain('ai.apiKey')
    // 缺 key 是 W1 的 bug：渲染层不该看到 undefined
    for (const key of SETTING_KEYS) {
      expect(all[key]).not.toBeUndefined()
    }
  })

  it('只存改过的 key，读取时按默认值合并（未改的仍是默认）', () => {
    settingRepo.set('app.theme', 'dark')
    settingRepo.set('points.dailyBase', 2)

    const keys = settingRepo.listOverriddenKeys()
    expect(keys.sort()).toEqual(['app.theme', 'points.dailyBase'])

    const all = settingRepo.getAll()
    expect(all['app.theme']).toBe('dark')
    expect(all['points.dailyBase']).toBe(2)
    expect(all['points.difficultyBase']).toEqual(DEFAULT_SETTINGS['points.difficultyBase'])
    expect(all['ai.provider']).toEqual({ name: 'zhipu', model: 'glm-5.3-flash' })
  })

  it('set 后再 get 拿到收敛后的值（对象型配置整块替换）', () => {
    const next: AppSettings['points.streakBonus'] = [{ days: 3, bonus: 2 }]
    expect(settingRepo.set('points.streakBonus', next)).toEqual(next)
    expect(settingRepo.get('points.streakBonus')).toEqual(next)
  })

  it('reset 删掉覆盖值，回到默认', () => {
    settingRepo.set('app.theme', 'dark')
    settingRepo.reset('app.theme')
    expect(settingRepo.get('app.theme')).toBe('light')
    expect(settingRepo.listOverriddenKeys()).toHaveLength(0)
  })

  it('库里 JSON 坏了必须抛错，不许静默回默认值', () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('channel.webhook','{not json','2026-10-28T00:00:00.000Z')`
    ).run()

    expectErrorCode(() => settingRepo.getAll(), 'DB_ERROR')
    expectErrorCode(() => settingRepo.get('channel.webhook'), 'DB_ERROR')
  })

  it('写未登记的 key 被拒（key 是封闭集合）', () => {
    expectErrorCode(
      () => settingRepo.set('ai.apiKey' as keyof AppSettings, 'sk-xxx' as never),
      'INVALID_INPUT'
    )
  })

  it('库里残留未知 key 时 getAll 不崩、也不把它塞进返回类型', () => {
    getDb()
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES ('future.flag','true','2026-10-28T00:00:00.000Z')`
      )
      .run()
    const all = settingRepo.getAll()
    expect(Object.keys(all)).toHaveLength(14)
    expect((all as unknown as Record<string, unknown>)['future.flag']).toBeUndefined()
  })
})
