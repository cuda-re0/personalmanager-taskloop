import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPLIT,
  MIN_BOTTOM_PX,
  MIN_TOP_PX,
  SPLIT_STORAGE_KEY,
  clampBottomPx,
  parseSplit,
  ratioFromY,
  serializeSplit
} from '../../src/renderer/main/features/splitModel'

/**
 * 右栏比例模型（04 §4① v0.29）纯逻辑：夹限、指针换算、存储序列化。
 * splitModel.ts 不 import 任何碰 window 的模块（07 硬约束 1），本文件可直接 import。
 */

describe('常量', () => {
  it('默认比例与拖动下限按契约锁定', () => {
    expect(DEFAULT_SPLIT).toBe(0.71)
    expect(MIN_TOP_PX).toBe(160)
    expect(MIN_BOTTOM_PX).toBe(360)
    expect(SPLIT_STORAGE_KEY).toBe('taskloop.rightSplit')
  })
})

describe('clampBottomPx（夹限，到限夹住不回弹）', () => {
  it('区间内不动', () => {
    expect(clampBottomPx(500, 800)).toBe(500)
    expect(clampBottomPx(360, 800)).toBe(360)
    expect(clampBottomPx(640, 800)).toBe(640)
  })

  it('低于下半下限抬到 360，高于上限压回 容器高-160', () => {
    expect(clampBottomPx(100, 800)).toBe(360)
    expect(clampBottomPx(2000, 800)).toBe(640)
    expect(clampBottomPx(800, 800)).toBe(640)
  })

  it('容器比上、下限之和还矮时，以上半 160px 下限优先', () => {
    // 400 - 160 = 240 < 360 → maxBottom 赢
    expect(clampBottomPx(400, 400)).toBe(240)
    expect(clampBottomPx(0, 400)).toBe(240)
  })

  it('容器高为 0（ rect 未量到）时返回 0，不产生 NaN', () => {
    expect(clampBottomPx(500, 0)).toBe(0)
  })
})

describe('ratioFromY（指针 y → 下半像素 → 夹限 → 除以容器高）', () => {
  const rect = { top: 100, height: 800 }

  it('容器内正常换算', () => {
    expect(ratioFromY(400, rect)).toBe(0.625) // 下半 500 / 800
    expect(ratioFromY(540, rect)).toBeCloseTo(0.45, 10) // 下半 360 = 下限
  })

  it('指针拖到容器下方之外 → 夹在下限', () => {
    expect(ratioFromY(2000, rect)).toBe(360 / 800)
  })

  it('指针拖到容器上方之外 → 夹在上限（下半 = 高-160）', () => {
    expect(ratioFromY(-100, rect)).toBe(640 / 800)
  })

  it('top 偏移参与换算（rect 不是从 0 开始）', () => {
    // y=350 → 下半 = 100+800-350 = 550（区间内，未触发夹限）
    expect(ratioFromY(350, rect)).toBeCloseTo(550 / 800, 10)
  })

  it('容器高为 0 时回落默认比例，不产生 NaN / Infinity', () => {
    expect(ratioFromY(300, { top: 0, height: 0 })).toBe(DEFAULT_SPLIT)
  })

  it('容器矮于两限之和时也落在合法比例区间内', () => {
    const r = ratioFromY(200, { top: 0, height: 400 })
    expect(r).toBe(240 / 400)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(1)
  })
})

describe('parseSplit（非法 / 越界回落默认）', () => {
  it('null / 空串 / 乱码 / 非数字回落默认', () => {
    expect(parseSplit(null)).toBe(DEFAULT_SPLIT)
    expect(parseSplit('')).toBe(DEFAULT_SPLIT)
    expect(parseSplit('   ')).toBe(DEFAULT_SPLIT)
    expect(parseSplit('garbage')).toBe(DEFAULT_SPLIT)
    expect(parseSplit('NaN')).toBe(DEFAULT_SPLIT)
  })

  it('越界（≤0、≥1）回落默认', () => {
    expect(parseSplit('0')).toBe(DEFAULT_SPLIT)
    expect(parseSplit('-0.5')).toBe(DEFAULT_SPLIT)
    expect(parseSplit('1')).toBe(DEFAULT_SPLIT)
    expect(parseSplit('1.5')).toBe(DEFAULT_SPLIT)
  })

  it('合法十进制小数原样接受（含前后空白）', () => {
    expect(parseSplit('0.5')).toBe(0.5)
    expect(parseSplit(' 0.4 ')).toBe(0.4)
    expect(parseSplit('0.001')).toBe(0.001)
    expect(parseSplit('0.999')).toBe(0.999)
  })
})

describe('serializeSplit（r → 十进制字符串）', () => {
  it('序列化后能原样读回', () => {
    expect(serializeSplit(0.5)).toBe('0.5')
    for (const r of [0.35, 0.71, 0.999, 0.001]) {
      expect(parseSplit(serializeSplit(r))).toBe(r)
    }
  })
})
