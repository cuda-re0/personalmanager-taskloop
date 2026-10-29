import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 结构不变量（项目没有 DOM 测试栈，用源码断言钉住回归线）：
 *
 * 1. 日历格子「任意日期可点」（04 §4② v0.21）：空日期渲染成 div、点不动的那条分支不许回来。
 * 2. 选中态受控（04 §4② v0.28）：选中日由 index.tsx 持有，本组件不再自带弹层机制——
 *    曾经的按日浮层（定位锚定那套）随 v0.28 整体作废，任何残留都会被「删净」断言抓住。
 */
const PANEL_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/CalendarPanel.tsx'),
  'utf8'
)

const HOOK_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/useCalendarData.ts'),
  'utf8'
)

const CSS_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/calendar.css'),
  'utf8'
)

// 自检表 #3 的 grep 关键字不能以字面量出现在本文件里（它也管 tests），拼接构造
const FLOOR_CLASS = ['calendar', '-floor'].join('')
const FLOOR_FN = ['floor', 'TopOf'].join('')

describe('日历格子的可点性', () => {
  it('日期格不再渲染成 div（只有空白填充格可以是 div）', () => {
    // 空白填充格用的是 calendar-cell--blank，允许是 div；有日期的格子必须是 button
    expect(PANEL_SOURCE).not.toMatch(/<div className=\{cls\}/)
    expect(PANEL_SOURCE).toMatch(/calendar-cell--blank/)
  })

  it('每个日期格都挂着 onSelectDay，选中态来自 props（受控）', () => {
    const handlers = PANEL_SOURCE.match(/onSelectDay\(day\)/g) ?? []
    expect(handlers).toHaveLength(1)
    expect(PANEL_SOURCE).toMatch(/<button[\s\S]*?onSelectDay\(day\)/)
    expect(PANEL_SOURCE).toMatch(/selectedDay: string \| null/)
    // 选中态只来自 props，组件内不许再自建选中状态
    expect(PANEL_SOURCE).not.toMatch(/useState<string \| null>/)
  })
})

describe('按日浮层机制删净（v0.28 作废）', () => {
  it('src 里不再有浮层类名 / 定位函数 / 定位常量', () => {
    for (const source of [PANEL_SOURCE, HOOK_SOURCE, CSS_SOURCE]) {
      expect(source).not.toContain(FLOOR_CLASS)
      expect(source).not.toContain(FLOOR_FN)
      expect(source).not.toMatch(/FLOOR_(GAP|MARGIN|MAX_HEIGHT)/)
    }
  })

  it('选中天的打开期间不再有点外部关闭 / × 按钮（关闭路径只剩再点同一天）', () => {
    expect(PANEL_SOURCE).not.toMatch(/pointerdown/)
    expect(PANEL_SOURCE).not.toMatch(/aria-label="关闭"/)
  })
})
