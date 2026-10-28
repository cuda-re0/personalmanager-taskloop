import { describe, expect, it } from 'vitest'
import type { DayStat, PointEntry } from '@shared/types/domain'
import {
  RANGE_LABEL,
  barsOf,
  canUndoEntry,
  formatSigned,
  lastDays,
  monthStartOf,
  rangeOf,
  shiftDay,
  sumPoints,
  timeLabel,
  weekStartOf
} from '../../src/renderer/main/features/points/pointsModel'

/** 右栏 ③④ 的纯模型（04 §4③④）。造数器只填用到的字段 */
function stat(day: string, points: number): DayStat {
  return { day, points, tasksDone: 0, tasksCreated: 0, occurrencesDone: 0 }
}

describe('日期区间', () => {
  it('本周一：周一返回自己，周日回到上一个周一（ISO 周几 1=周一）', () => {
    // 2026-10-26 是周一，2026-10-28 是周三，2026-11-01 是周日
    expect(weekStartOf('2026-10-26')).toBe('2026-10-26')
    expect(weekStartOf('2026-10-28')).toBe('2026-10-26')
    expect(weekStartOf('2026-11-01')).toBe('2026-10-26')
  })

  it('shiftDay 跨月跨年都正确', () => {
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('三个切换的区间都是「截至今天」的闭区间', () => {
    expect(rangeOf('today', '2026-10-28')).toEqual({ from: '2026-10-28', to: '2026-10-28' })
    expect(rangeOf('week', '2026-10-28')).toEqual({ from: '2026-10-26', to: '2026-10-28' })
    expect(rangeOf('month', '2026-10-28')).toEqual({ from: '2026-10-01', to: '2026-10-28' })
    expect(monthStartOf('2026-02-14')).toBe('2026-02-01')
  })

  it('最近 7 天升序且以今天结尾（含跨月）', () => {
    const days = lastDays('2026-11-02', 7)
    expect(days).toHaveLength(7)
    expect(days[6]).toBe('2026-11-02')
    expect(days[0]).toBe('2026-10-27')
    expect([...days].sort()).toEqual(days)
  })
})

describe('求和与柱状', () => {
  const stats = [
    stat('2026-10-26', 20),
    stat('2026-10-27', 0),
    stat('2026-10-28', 13.2),
    stat('2026-10-29', 999) // 未来（不该被算进「截至今天」的窗口）
  ]

  it('只加闭区间内的日聚合值', () => {
    expect(sumPoints(stats, '2026-10-26', '2026-10-28')).toBe(33.2)
    expect(sumPoints(stats, '2026-10-28', '2026-10-28')).toBe(13.2)
    expect(sumPoints(stats, '2026-10-01', '2026-09-01')).toBe(0)
  })

  it('7 根柱子：峰值比例为 1，零值给最矮基线，未来日期不参与', () => {
    const bars = barsOf(stats, '2026-10-28')
    expect(bars).toHaveLength(7)
    expect(bars[6].day).toBe('2026-10-28')
    expect(bars.map(b => b.day)).not.toContain('2026-10-29')
    const peak = Math.max(...bars.map(b => b.ratio))
    expect(peak).toBe(1)
    expect(bars[1].ratio).toBe(0.06)
    expect(bars.every(b => b.ratio > 0 && b.ratio <= 1)).toBe(true)
  })

  it('全是 0 分时每根柱子仍有可见高度（不出现 0 高度）', () => {
    const bars = barsOf([], '2026-10-28')
    expect(bars.every(b => b.ratio === 0.06)).toBe(true)
  })

  it('负数（冲销日）按 0 处理，不画朝下的柱子', () => {
    const bars = barsOf([stat('2026-10-28', -5)], '2026-10-28')
    expect(bars[6].points).toBe(-5)
    expect(bars[6].ratio).toBe(0.06)
  })
})

describe('显示格式（04 §4③：金额走 fmtPoints，±N 带符号）', () => {
  it('正数带 +、负数原样、0 显示 +0；小数按 fmtPoints 去尾零', () => {
    expect(formatSigned(11)).toBe('+11')
    expect(formatSigned(48.3)).toBe('+48.3')
    expect(formatSigned(5.5)).toBe('+5.5')
    expect(formatSigned(-10.75)).toBe('-10.75')
    expect(formatSigned(0)).toBe('+0')
  })

  it('时刻是本地 HH:mm', () => {
    expect(timeLabel(new Date(2026, 9, 28, 9, 5).toISOString())).toBe('09:05')
    expect(timeLabel(new Date(2026, 9, 28, 23, 59).toISOString())).toBe('23:59')
    expect(timeLabel('not-a-date')).toBe('')
  })

  it('三个切换的标签是登记过的固定串', () => {
    expect(RANGE_LABEL).toEqual({ today: '今日', week: '本周', month: '本月' })
  })
})

describe('④ 行尾 [撤销] 的三条件（04 §4④）', () => {
  /** 造一条流水，只有用到的字段有值 */
  function entry(patch: Partial<PointEntry> = {}): PointEntry {
    return {
      id: 'e1',
      taskId: 't1',
      occurrenceId: null,
      delta: 20,
      kind: 'award',
      reasonCode: 'task_done',
      reasonText: '交作业',
      day: '2026-10-28',
      createdAt: '2026-10-28T01:00:00.000Z',
      reversedAt: null,
      ...patch
    }
  }

  it('计分完成行（task_done + 无 occurrence + 未冲销）才显示', () => {
    expect(canUndoEntry(entry())).toBe(true)
  })

  it('三条缺一条都不显示', () => {
    // 已冲销：再撤就是重复冲销
    expect(canUndoEntry(entry({ reversedAt: '2026-10-28T02:00:00.000Z' }))).toBe(false)
    // 每日打卡：撤销在 ① 的勾选框（occurrence.undo），不在这里
    expect(canUndoEntry(entry({ occurrenceId: 'o1' }))).toBe(false)
    // 不是完成发分：冲销行、里程碑奖励、手工调整都没有撤销入口
    for (const reasonCode of ['streak_bonus', 'manual_adjust', 'quality_bonus'] as const) {
      expect(canUndoEntry(entry({ reasonCode }))).toBe(false)
    }
  })
})
