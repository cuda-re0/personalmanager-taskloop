import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 日历折叠（92a-fix2）不变量：折叠态只留标题行、把空间全让给下面的面板；
 * 展开态网格自己 overflow-y，窗口变矮时日期行在网格内滚，不压到下面面板上。
 * 折叠状态记 localStorage，重开保持；按钮是图标，唯一文字是 aria-label。
 */

const PANEL_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/CalendarPanel.tsx'),
  'utf8'
)

const CALENDAR_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/calendar.css'),
  'utf8'
)

/** 从锚定行首的选择器开始截一段规则体（`}` 为止），避开伪元素与后代选择器 */
function ruleBodyAt(css: string, selectorPattern: RegExp): string {
  const match = selectorPattern.exec(css)
  expect(match, String(selectorPattern)).not.toBeNull()
  return css.slice(match!.index).split('}')[0]
}

describe('日历折叠 · 组件（CalendarPanel.tsx）', () => {
  it('折叠态是根节点上的 className 分支：calendar-panel--collapsed', () => {
    expect(PANEL_SOURCE).toMatch(
      /collapsed \? 'calendar-panel calendar-panel--collapsed' : 'calendar-panel'/
    )
  })

  it('状态记 localStorage：taskloop:calendar:collapsed', () => {
    expect(PANEL_SOURCE).toContain("'taskloop:calendar:collapsed'")
  })

  it('按钮是图标，唯一文字是 aria-label 的「折叠日历」/「展开日历」', () => {
    expect(PANEL_SOURCE).toMatch(/collapsed \? '展开日历' : '折叠日历'/)
    expect(PANEL_SOURCE).toMatch(/<svg/)
    // 不用字符符号（▾ / ▲ / ⌃ 之类）
    expect(PANEL_SOURCE).not.toMatch(/[▾▴▲▼△▽⌃⌄]/)
  })
})

describe('日历折叠 · 样式（calendar.css）', () => {
  it('折叠态不吃剩余空间：flex: 0 0 auto', () => {
    const body = ruleBodyAt(CALENDAR_CSS, /^\.calendar-panel--collapsed\s*\{/m)
    expect(body).toMatch(/flex:\s*0 0 auto/)
  })

  it('折叠态藏掉星期行与网格：display: none', () => {
    const body = ruleBodyAt(CALENDAR_CSS, /^\.calendar-panel--collapsed \.calendar-grid\s*\{/m)
    expect(body).toMatch(/display:\s*none/)
    expect(CALENDAR_CSS).toMatch(/\.calendar-panel--collapsed \.calendar-weekdays/)
  })

  it('展开态网格内部滚动：.calendar-grid 有 overflow-y: auto', () => {
    const body = ruleBodyAt(CALENDAR_CSS, /^\.calendar-grid\s*\{/m)
    expect(body).toMatch(/overflow-y:\s*auto/)
  })

  it('网格滚动条与 .tasks-panel 同口径（6px 宽、按钮不显示）', () => {
    expect(CALENDAR_CSS).toMatch(/\.calendar-grid::-webkit-scrollbar\s*\{/)
    expect(CALENDAR_CSS).toMatch(/\.calendar-grid::-webkit-scrollbar-thumb\s*\{/)
    expect(CALENDAR_CSS).toMatch(/\.calendar-grid::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/)
  })
})
