import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 结构不变量（项目没有 DOM 测试栈，用源码断言钉住两条回归线）：
 *
 * 1. 日历格子「任意日期可点」（04 §4② v0.21）：≤v0.20 的写法是 `dot === 'none' ? <div> : <button>`，
 *    空日期渲染成 div、点不动；只要有人把无红点分支写回来，这条就会红。
 * 2. 浮层贴被点行（23 号开工词问题 2）：位置锚定曾经在 CSS 里写成面板底的 `top: 100%`，
 *    用户真机看到"框直接跑到最底部"。现在纵向位置只允许由内联给出、锚点来自格子自身几何。
 */
const PANEL_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/CalendarPanel.tsx'),
  'utf8'
)

const CSS_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/calendar.css'),
  'utf8'
)

/** 取出 `.calendar-floor { ... }` 的规则体（到第一个收尾大括号为止） */
function floorRuleBody(): string {
  const start = CSS_SOURCE.indexOf('.calendar-floor {')
  expect(start).toBeGreaterThan(-1)
  return CSS_SOURCE.slice(start).split('}')[0]
}

describe('日历格子的可点性', () => {
  it('日期格不再渲染成 div（只有空白填充格可以是 div）', () => {
    // 空白填充格用的是 calendar-cell--blank，允许是 div；有日期的格子必须是 button
    expect(PANEL_SOURCE).not.toMatch(/<div className=\{cls\}/)
    expect(PANEL_SOURCE).toMatch(/calendar-cell--blank/)
  })

  it('每个日期格都挂着 selectDay', () => {
    const handlers = PANEL_SOURCE.match(/actions\.selectDay\(day\)/g) ?? []
    expect(handlers).toHaveLength(1)
    // 格子本身必须是 button，否则键盘/焦点都进不去
    expect(PANEL_SOURCE).toMatch(/<button[\s\S]*?actions\.selectDay\(day\)/)
  })
})

describe('浮层定位不被写回面板底部（23 号开工词问题 2）', () => {
  it('CSS 的 .calendar-floor 规则里没有纵向定位（top 由内联给）', () => {
    const body = floorRuleBody()
    expect(body).not.toMatch(/^\s*top:/m)
    expect(body).not.toMatch(/margin-top/)
    // 水平与网格 16px 内缩对齐（.calendar-grid 的 padding: 2px 16px 0）
    expect(body).toMatch(/left:\s*16px/)
    expect(body).toMatch(/right:\s*16px/)
  })

  it('浮层节点带内联 top，锚点取自格子自身的 offsetTop/offsetHeight', () => {
    expect(PANEL_SOURCE).toMatch(/className="calendar-floor" ref=\{floorRef\} style=\{\{ top: floorTop \}\}/)
    expect(PANEL_SOURCE).toMatch(/offsetTop/)
    expect(PANEL_SOURCE).toMatch(/offsetHeight/)
    // 位置计算走纯函数，不渲染期量 DOM
    expect(PANEL_SOURCE).toMatch(/floorTopOf\(/)
  })

  it('floorTopOf 的翻面与钳零逻辑不被删（贴行下方 / 放不下翻上方 / 出界钳回 0）', () => {
    // 默认贴行底 +2
    expect(PANEL_SOURCE).toMatch(/cellTop \+ cellHeight \+ FLOOR_GAP/)
    // 下方放不下 → 翻到行上方（缺这条会退化回"永远贴底"）
    expect(PANEL_SOURCE).toMatch(/cellTop - floorHeight - FLOOR_GAP/)
    // 翻上去仍出界 → 钳回 0（缺这条浮层会被裁掉）
    expect(PANEL_SOURCE).toMatch(/if \(top < 0\) top = 0/)
  })
})
