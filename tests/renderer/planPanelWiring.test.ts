import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 计划面板（92a-fix）高度不变量：`.plan-panel` 是 ④ 槽位的内容，不是独立整块——
 * 同一 `.right-half` 里上面还有 `.calendar-panel`（flex: 0 1 240px）。
 * `height: 100%` 是按整个下半块算的，而 `.plan-panel` 只应吃日历之后的剩余空间；
 * 这个写法依赖 flex 的隐式收缩才不出问题，换成 `flex: 1 1 auto; min-height: 0` 后
 * 行为与 `.calendar-dayview` 一致且确定。
 */

const PLAN_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/plan/plan.css'),
  'utf8'
)

/** 只截 `.plan-panel { ... }` 这一段，避开 `::-webkit-scrollbar` 那几条伪元素规则 */
function planPanelRuleBody(css: string): string {
  const match = /^\.plan-panel\s*\{/m.exec(css)
  expect(match, '.plan-panel 规则').not.toBeNull()
  return css.slice(match!.index).split('}')[0]
}

const BODY = planPanelRuleBody(PLAN_CSS)

describe('.plan-panel 高度口径（92a-fix）', () => {
  it('吃满日历之后的剩余空间：flex: 1 1 auto', () => {
    expect(BODY).toMatch(/flex:\s*1 1 auto/)
  })

  it('允许被压缩到 0：min-height: 0（不被内容高度顶住）', () => {
    expect(BODY).toMatch(/min-height:\s*0/)
  })

  it('不再用 height: 100%：高度应来自 flex 分配，不按整块百分比算', () => {
    expect(BODY).not.toMatch(/height:\s*100%/)
    // 内部滚动仍在：删高度不能顺手删掉滚动
    expect(BODY).toMatch(/overflow-y:\s*auto/)
  })
})
