import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 结构不变量：日历格子「任意日期可点」（04 §4② v0.21）。
 *
 * 为什么用源码断言：项目没有 DOM 测试栈。≤v0.20 的写法是 `dot === 'none' ? <div> : <button>`，
 * 空日期渲染成 div、点不动；用户要求「点哪天就看哪天，没任务也留白」，那条分支必须消失。
 * 只要有人把无红点分支写回来，这条就会红。
 */
const SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/CalendarPanel.tsx'),
  'utf8'
)

describe('日历格子的可点性', () => {
  it('日期格不再渲染成 div（只有空白填充格可以是 div）', () => {
    // 空白填充格用的是 calendar-cell--blank，允许是 div；有日期的格子必须是 button
    expect(SOURCE).not.toMatch(/<div className=\{cls\}/)
    expect(SOURCE).toMatch(/calendar-cell--blank/)
  })

  it('每个日期格都挂着 selectDay', () => {
    const handlers = SOURCE.match(/onClick=\{\(\) => actions\.selectDay\(day\)\}/g) ?? []
    expect(handlers).toHaveLength(1)
    // 格子本身必须是 button，否则键盘/焦点都进不去
    expect(SOURCE).toMatch(/<button[\s\S]*?onClick=\{\(\) => actions\.selectDay\(day\)\}/)
  })
})
