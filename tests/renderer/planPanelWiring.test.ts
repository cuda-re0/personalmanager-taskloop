import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 计划面板（92a-fix）高度不变量：`.plan-panel` 是 ④ 槽位的内容，不是独立整块——
 * 同一 `.right-half` 里上面还有 `.calendar-panel`（flex: 0 1 240px）。
 * 所以它必须走 `.calendar-dayview` 同一口径（flex: 1 1 auto + min-height: 0），
 * 不能用 `height: 100%`：那是按整块下半高算的，会多出约 240px，
 * 撑出 `.right-half`（overflow: hidden）导致底部被裁、滚动条跑到可视区外。
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

  it('允许被压缩到 0：min-height: 0（否则内容高度顶住，撑破 .right-half）', () => {
    expect(BODY).toMatch(/min-height:\s*0/)
  })

  it('不再用 height: 100%：它不是整块，按整块算会多出日历那 240px', () => {
    expect(BODY).not.toMatch(/height:\s*100%/)
    // 内部滚动仍在：删高度不能顺手删掉滚动
    expect(BODY).toMatch(/overflow-y:\s*auto/)
  })
})
