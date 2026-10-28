import { describe, expect, it } from 'vitest'
import type { DayIndexEntry, DayTaskItem } from '@shared/types/domain'
import {
  WEEKDAY_HEADERS,
  buildMonthGrid,
  dayOf,
  dotStateOf,
  floorTitle,
  indexByDay,
  monthKey,
  monthTitle,
  shiftMonth,
  sortDayDetail,
  toLocalDay,
  weekdayCnOfDay
} from '../../src/renderer/main/features/calendar/calendarModel'

/** 右栏②的纯模型（04 §4②）。红点口径来自主进程，这里只测映射与日期算术 */

function entry(day: string, total: number, doneCount: number): DayIndexEntry {
  return { day, total, doneCount }
}

function item(seed: Partial<DayTaskItem> & Pick<DayTaskItem, 'taskId' | 'time'>): DayTaskItem {
  return {
    type: 'deadline',
    title: '任务',
    dueAt: `2026-10-27T${seed.time}:00.000Z`,
    status: 'todo',
    points: 20,
    ...seed
  }
}

describe('toLocalDay（本地日口径，不用 toISOString）', () => {
  it('取本地字段：凌晨 00:30 仍算当天，不因 UTC 落在前一天而串日', () => {
    // 东八区下 toISOString().slice(0,10) 会给 2026-09-30——这正是 01 §4.1 的时区陷阱
    expect(toLocalDay(new Date(2026, 9, 1, 0, 30))).toBe('2026-10-01')
  })

  it('月末 23:59 仍算当天', () => {
    expect(toLocalDay(new Date(2026, 9, 31, 23, 59))).toBe('2026-10-31')
  })

  it('月/日补零', () => {
    expect(toLocalDay(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05')
  })
})

describe('dayOf / monthKey / monthTitle', () => {
  it('dayOf 补零成 YYYY-MM-DD', () => {
    expect(dayOf(2026, 10, 27)).toBe('2026-10-27')
    expect(dayOf(2026, 1, 5)).toBe('2026-01-05')
  })

  it('monthKey 是切月的去重依赖', () => {
    expect(monthKey(2026, 10)).toBe('2026-10')
    expect(monthKey(2026, 1)).toBe('2026-01')
  })

  it('monthTitle 用 04 §4② 的显示格式，月份不补零', () => {
    expect(monthTitle(2026, 10)).toBe('2026 年 10 月')
    expect(monthTitle(2026, 1)).toBe('2026 年 1 月')
  })
})

describe('shiftMonth（上/下月，跨年正确）', () => {
  it('年内前后移动', () => {
    expect(shiftMonth(2026, 10, 1)).toEqual({ year: 2026, month: 11 })
    expect(shiftMonth(2026, 10, -1)).toEqual({ year: 2026, month: 9 })
  })

  it('12 月 +1 → 次年 1 月；1 月 -1 → 上年 12 月', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
  })

  it('一次跨多年也对', () => {
    // 2026-03 + 22 个月 = 2028-01（3 月 + 22 = 第 25 个月）
    expect(shiftMonth(2026, 3, 22)).toEqual({ year: 2028, month: 1 })
    expect(shiftMonth(2026, 3, -22)).toEqual({ year: 2024, month: 5 })
  })
})

describe('buildMonthGrid（7 列、周一起始、非本月留空）', () => {
  it('列头是周一起始的七个字', () => {
    expect([...WEEKDAY_HEADERS]).toEqual(['一', '二', '三', '四', '五', '六', '日'])
  })

  it('2026 年 10 月：1 号是周四，前面 3 格空', () => {
    const grid = buildMonthGrid(2026, 10)
    expect(grid.weeks[0]).toEqual([null, null, null, 1, 2, 3, 4])
    expect(grid.weeks.length).toBe(5)
    expect(grid.weeks.every(w => w.length === 7)).toBe(true)
    const days = grid.weeks.flat().filter((d): d is number => d !== null)
    expect(days.length).toBe(31)
    expect(days[0]).toBe(1)
    expect(days[30]).toBe(31)
  })

  it('2026 年 6 月：1 号是周一，不留前置空格', () => {
    expect(buildMonthGrid(2026, 6).weeks[0][0]).toBe(1)
  })

  it('2026 年 2 月（28 天）与 2028 年 2 月（闰年 29 天）', () => {
    const feb26 = buildMonthGrid(2026, 2)
      .weeks.flat()
      .filter(d => d !== null)
    const feb28 = buildMonthGrid(2028, 2)
      .weeks.flat()
      .filter(d => d !== null)
    expect(feb26.length).toBe(28)
    expect(feb28.length).toBe(29)
    expect(feb28[feb28.length - 1]).toBe(29)
  })

  it('需要 6 行的月份给出 6 行，不硬凑空行', () => {
    // 2026 年 11 月：1 号是周日，31 天 → 前置 6 格，共 37 格 → 6 行
    expect(buildMonthGrid(2026, 11).weeks.length).toBe(6)
  })

  it('跨年月份（2027 年 1 月）网格自洽', () => {
    const grid = buildMonthGrid(2027, 1)
    // 2027-01-01 是周五，周一起始 → 前置 4 格
    expect(grid.weeks[0][4]).toBe(1)
    expect(grid.weeks.flat().filter(d => d !== null).length).toBe(31)
  })
})

describe('dotStateOf（红点口径只来自主进程）', () => {
  it('无索引 / total 为 0 → 无点', () => {
    expect(dotStateOf(undefined)).toBe('none')
    expect(dotStateOf(entry('2026-10-27', 0, 0))).toBe('none')
  })

  it('有未完成 → 实心；全部完成 → 空心', () => {
    expect(dotStateOf(entry('2026-10-27', 3, 1))).toBe('solid')
    expect(dotStateOf(entry('2026-10-27', 1, 0))).toBe('solid')
    expect(dotStateOf(entry('2026-10-27', 3, 3))).toBe('hollow')
  })

  it('doneCount 不小于 total 一律空心（口径异常也不回退成实心）', () => {
    expect(dotStateOf(entry('2026-10-27', 2, 5))).toBe('hollow')
  })
})

describe('indexByDay', () => {
  it('按日本地日索引，O(1) 查，不按月全表扫', () => {
    const map = indexByDay([entry('2026-10-27', 2, 0), entry('2026-10-03', 1, 1)])
    expect(map.get('2026-10-27')).toEqual({ day: '2026-10-27', total: 2, doneCount: 0 })
    expect(map.get('2026-10-03')?.doneCount).toBe(1)
    expect(map.get('2026-10-04')).toBeUndefined()
  })
})

describe('floorTitle / weekdayCnOfDay（浮层标题）', () => {
  it('10 月 27 日 周二（04 §4② 的浮层示意）', () => {
    expect(floorTitle('2026-10-27')).toBe('10 月 27 日 周二')
  })

  it('个位数月/日不补零', () => {
    expect(floorTitle('2026-01-05')).toBe('1 月 5 日 周一')
  })

  it('周日映射到 日', () => {
    expect(weekdayCnOfDay('2026-11-01')).toBe('日')
  })
})

describe('sortDayDetail（按时间升序）', () => {
  it('按 HH:mm 升序，不修改入参', () => {
    const items = [
      item({ taskId: 'b', time: '18:00' }),
      item({ taskId: 'a', time: '09:00' }),
      item({ taskId: 'c', time: '12:30' })
    ]
    const sorted = sortDayDetail(items)
    expect(sorted.map(i => i.taskId)).toEqual(['a', 'c', 'b'])
    expect(items.map(i => i.taskId)).toEqual(['b', 'a', 'c'])
  })

  it('同一时刻按 dueAt 再定序', () => {
    const items = [
      item({ taskId: 'late', time: '09:00', dueAt: '2026-10-27T09:00:05.000Z' }),
      item({ taskId: 'early', time: '09:00', dueAt: '2026-10-27T09:00:01.000Z' })
    ]
    expect(sortDayDetail(items).map(i => i.taskId)).toEqual(['early', 'late'])
  })
})
