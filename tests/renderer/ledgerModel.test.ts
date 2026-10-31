import { describe, expect, it } from 'vitest'
import type { DayStat, PointEntry } from '@shared/types/domain'
import {
  canGoNextMonth,
  dayLabelOf,
  daysInMonth,
  groupEntriesByDay,
  monthEndOf,
  monthLabelOf,
  monthNetOf,
  monthRangeOf,
  netLabel,
  shiftMonthOf,
  stepMonthOf
} from '../../src/renderer/main/features/points/ledgerModel'
import { monthStartOf } from '../../src/renderer/main/features/points/pointsModel'

/**
 * 明细页（04 §4④ v0.24）的纯模型。
 *
 * 这一组用例锁的是**口径**而不是实现细节：月末按实际天数、当月不可往后翻、
 * 分组顺序、净额只认日聚合（不被 `limit` 截断影响）。
 */

function stat(day: string, points: number): DayStat {
  return { day, points, tasksDone: 0, tasksCreated: 0, occurrencesDone: 0 }
}

function entry(patch: Partial<PointEntry> & { id: string }): PointEntry {
  return {
    taskId: 't1',
    occurrenceId: null,
    delta: 1,
    kind: 'award',
    reasonCode: 'task_done',
    reasonText: '写季度复盘初稿',
    day: '2026-10-28',
    createdAt: '2026-10-28T02:18:00.000Z',
    reversedAt: null,
    // v0.45：流水多了两列（只有支出行有值），夹具按"不是支出"填 null
    amountCents: null,
    fxRate: null,
    ...patch
  }
}

describe('月末：按实际天数算，不写死 30（口径 7）', () => {
  it('平年 2 月 28 天、闰年 2 月 29 天', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(monthEndOf('2026-02-01')).toBe('2026-02-28')
    expect(monthEndOf('2024-02-01')).toBe('2024-02-29')
  })

  it('30 天的月份（4 月）与 31 天的月份（1 月）', () => {
    expect(monthEndOf('2026-04-01')).toBe('2026-04-30')
    expect(monthEndOf('2026-01-01')).toBe('2026-01-31')
    expect(monthEndOf('2026-12-01')).toBe('2026-12-31')
  })

  it('查询区间是闭区间，from 就是当月 1 号', () => {
    expect(monthRangeOf('2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(monthRangeOf('2024-02-01')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
  })
})

describe('翻月与页头文案', () => {
  it('shiftMonthOf 跨年正确（1 月前一月是去年 12 月，12 月后一月是明年 1 月）', () => {
    expect(shiftMonthOf('2026-10-01', -1)).toBe('2026-09-01')
    expect(shiftMonthOf('2026-01-01', -1)).toBe('2025-12-01')
    expect(shiftMonthOf('2026-12-01', 1)).toBe('2027-01-01')
    expect(shiftMonthOf('2026-10-01', 1)).toBe('2026-11-01')
  })

  it('当月时 › 不可用：canGoNextMonth 对当月为 false、对过去的月为 true', () => {
    expect(canGoNextMonth('2026-10-01', '2026-10-29')).toBe(false)
    expect(canGoNextMonth('2026-10-01', '2026-10-31')).toBe(false)
    expect(canGoNextMonth('2026-09-01', '2026-10-29')).toBe(true)
    expect(canGoNextMonth('2025-12-01', '2026-01-01')).toBe(true)
  })

  it('点 › 在当月等于没点：stepMonthOf 原样返回，状态不变（口径 6）', () => {
    expect(stepMonthOf('2026-10-01', 1, '2026-10-29')).toBe('2026-10-01')
    // 跨到未来年也一样挡
    expect(stepMonthOf('2026-12-01', 1, '2026-12-31')).toBe('2026-12-01')
    // 往回翻不受影响
    expect(stepMonthOf('2026-10-01', -1, '2026-10-29')).toBe('2026-09-01')
    expect(stepMonthOf('2026-01-01', -1, '2026-10-29')).toBe('2025-12-01')
  })

  it('页头 `2026年10月`、组头 `10月28日`（不补前导零、不用相对时间）', () => {
    expect(monthLabelOf('2026-10-01')).toBe('2026年10月')
    expect(monthLabelOf('2026-01-01')).toBe('2026年1月')
    expect(dayLabelOf('2026-10-28')).toBe('10月28日')
    expect(dayLabelOf('2026-01-05')).toBe('1月5日')
  })
})

/**
 * v0.25 返工：`stepMonthOf` 曾复用 `canGoNextMonth` 的 `<` 判据，把 `next === 本月`
 * 也判成非法 —— 于是「上月 → 本月」这一格永远走不动（按钮亮着、点了没反应）。
 * 两个谓词回答的是不同问题：前者问"当前月还能不能往后"，后者问"落月合不合法"。
 */
describe('翻月（v0.25：上月 → 本月这一格）', () => {
  it('上月点 › 回到本月（返工的核心用例）', () => {
    expect(stepMonthOf('2026-09-01', 1, '2026-10-29')).toBe('2026-10-01')
  })

  it('本月点 › 原地不动（原有语义，不能被顺手改坏）', () => {
    expect(stepMonthOf('2026-10-01', 1, '2026-10-29')).toBe('2026-10-01')
  })

  it('跨月后：10 月能前进到 11 月（应用开着过夜那种）', () => {
    expect(stepMonthOf('2026-10-01', 1, '2026-11-03')).toBe('2026-11-01')
  })

  it('前两月点 › 只走一格（到次月，不是直接到本月）', () => {
    expect(stepMonthOf('2026-08-01', 1, '2026-10-29')).toBe('2026-09-01')
  })

  it('跨年：去年 12 月点 › 到今年 1 月', () => {
    expect(stepMonthOf('2025-12-01', 1, '2026-01-01')).toBe('2026-01-01')
  })

  it('未来月仍然挡住：落月晚于本月不动', () => {
    expect(stepMonthOf('2026-11-01', 1, '2026-10-29')).toBe('2026-11-01')
    expect(stepMonthOf('2026-12-01', 1, '2026-12-31')).toBe('2026-12-01')
  })

  it('不变量：按钮亮着就必须动（过去 24 个月逐一验证，含跨年）', () => {
    const today = '2026-10-29'
    const thisMonth = monthStartOf(today)
    for (let back = 1; back <= 24; back += 1) {
      const month = shiftMonthOf(thisMonth, -back)
      expect(canGoNextMonth(month, today), `${month} 的 › 应该是亮的`).toBe(true)
      expect(stepMonthOf(month, 1, today), `${month} 点亮着的 › 必须前进`).not.toBe(month)
      expect(stepMonthOf(month, 1, today)).toBe(shiftMonthOf(month, 1))
    }
  })
})

describe('净额：只求和日聚合（口径 8）', () => {
  it('当月净额是 DayStat.points 的求和，含负数日', () => {
    expect(monthNetOf([])).toBe(0)
    expect(monthNetOf([stat('2026-10-27', 20), stat('2026-10-28', -1)])).toBe(19)
    expect(monthNetOf([stat('2026-10-28', 13.2), stat('2026-10-29', 6.8)])).toBe(20)
  })

  it('流水被 limit 截断时净额仍然正确：净额来源不是流水', () => {
    // 假设当月 600 条流水，`limit: 500` 只回了 500 条（这里只留 2 条示意）
    const truncated = [entry({ id: 'e1', delta: 1 }), entry({ id: 'e2', delta: 1 })]
    const stats = Array.from({ length: 30 }, (_, i) =>
      stat(`2026-10-${String(i + 1).padStart(2, '0')}`, 1)
    )
    const ledgerSum = truncated.reduce((sum, e) => sum + e.delta, 0)

    expect(ledgerSum).toBe(2)
    // 净额走日聚合 → 30，不受截断影响；这正是两条通道分开的理由
    expect(monthNetOf(stats)).toBe(30)
  })

  it('netLabel：正数带 +、负数原样、0 就是 `0`（不是 `+0`）', () => {
    expect(netLabel(12)).toBe('+12')
    expect(netLabel(-1)).toBe('-1')
    expect(netLabel(0)).toBe('0')
    expect(netLabel(62.5)).toBe('+62.5')
    expect(netLabel(-10.75)).toBe('-10.75')
  })
})

describe('按日分组', () => {
  it('组间 day 降序、组内 createdAt 降序，不依赖入参顺序', () => {
    const groups = groupEntriesByDay([
      entry({ id: 'a', day: '2026-10-27', delta: -1, createdAt: '2026-10-27T13:30:00.000Z' }),
      entry({ id: 'b', day: '2026-10-28', delta: 1, createdAt: '2026-10-28T02:03:00.000Z' }),
      entry({ id: 'c', day: '2026-10-28', delta: 2, createdAt: '2026-10-28T16:18:00.000Z' })
    ])

    expect(groups.map(g => g.day)).toEqual(['2026-10-28', '2026-10-27'])
    expect(groups[0].entries.map(e => e.id)).toEqual(['c', 'b'])
    expect(groups[1].entries.map(e => e.id)).toEqual(['a'])
  })

  it('日净额是组内 delta 求和（完成 + 冲销同日抵消为 0）', () => {
    const groups = groupEntriesByDay([
      entry({ id: 'a', delta: 20 }),
      entry({ id: 'b', delta: -20, createdAt: '2026-10-28T03:00:00.000Z' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].net).toBe(0)
    expect(netLabel(groups[0].net)).toBe('0')
  })

  it('空列表 → 空分组（空月只渲染页头，不造占位行）', () => {
    expect(groupEntriesByDay([])).toEqual([])
  })
})
