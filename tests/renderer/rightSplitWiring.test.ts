import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 右栏比例分割线（04 §4① v0.29）结构不变量。项目没有 DOM 测试栈，
 * 组件/布局纪律一律用源码断言钉住（参照 calendarPanelWiring 的源码结构法）：
 *
 * 1. 分割线：role/aria/cursor/无文字 + Pointer Events 拖动。
 * 2. index.tsx：两半 flexGrow 来源 = r / 1-r，localStorage 读写各只有一处、只在 pointerup 落盘。
 * 3. CSS：两半 flex-basis 0 等比伸缩；③④ 吃下半块剩余，v0.28 的 348 定高字样在 src 全树 0 命中。
 */

const ROOT = process.cwd()

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

/** 剥掉注释再断言：注释不是可见文字，别让文档注释误伤「无文字」类断言 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start, selector).toBeGreaterThan(-1)
  return css.slice(start).split('}')[0]
}

const INDEX_CODE = stripComments(read('src/renderer/main/index.tsx'))
const SPLIT_CODE = stripComments(read('src/renderer/main/features/RightSplit.tsx'))
const MODEL_SOURCE = read('src/renderer/main/features/splitModel.ts')
const TASKS_CSS = read('src/renderer/main/features/tasks/tasks.css')
const POINTS_CSS = read('src/renderer/main/features/points/points.css')
const CALENDAR_CSS = read('src/renderer/main/features/calendar/calendar.css')

/** 递归收集 src 下所有文件（「348 字样 0 命中」要扫全树） */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

describe('分割线组件（RightSplit.tsx）', () => {
  it('结构：separator / horizontal / right-split，无 aria-label、无任何文字', () => {
    expect(SPLIT_CODE).toMatch(/role="separator"/)
    expect(SPLIT_CODE).toMatch(/aria-orientation="horizontal"/)
    expect(SPLIT_CODE).toMatch(/className="right-split"/)
    expect(SPLIT_CODE).not.toMatch(/aria-label/)
    // 渲染产物是自闭合 div：标签之间不写任何字符（04 §7 文案纪律）
    expect(SPLIT_CODE).toMatch(/<div\s+className="right-split"[\s\S]*\/>/)
    expect(SPLIT_CODE).not.toMatch(/>[^<>{}\s][^<>{}]*</)
    expect(SPLIT_CODE).not.toMatch(/[\u4e00-\u9fa5]/)
  })

  it('拖动：Pointer Events + setPointerCapture，move 上报、pointerup 才提交', () => {
    expect(SPLIT_CODE).toMatch(/setPointerCapture\(e\.pointerId\)/)
    expect(SPLIT_CODE).toMatch(/onPointerDown/)
    expect(SPLIT_CODE).toMatch(/onPointerMove/)
    expect(SPLIT_CODE).toMatch(/onPointerUp/)
    // capture 意外丢失（pointercancel 等异常路径）必须复位拖动位，否则后续 move 继续改比例
    expect(SPLIT_CODE).toMatch(/onLostPointerCapture/)
    // ratioFromY 只在 move 里调（拖动中实时更新，不落盘）
    expect(SPLIT_CODE.match(/ratioFromY\(/g)).toHaveLength(1)
    expect(SPLIT_CODE).toMatch(/if \(!dragging\.current\) return[\s\S]*ratioFromY\(/)
    // 提交用 ref 记的最新值，不用闭包 props——最后一步 setState 未重渲染时闭包是旧值
    expect(SPLIT_CODE).toMatch(/onCommit\(latest\.current\)/)
    expect(SPLIT_CODE).not.toMatch(/onCommit\(ratio\)/)
  })

  it('纯逻辑与组件分离：组件层不做夹限算术，换算只来自 splitModel', () => {
    expect(SPLIT_CODE).not.toMatch(/MIN_TOP_PX|MIN_BOTTOM_PX/)
    // 组件层唯一允许的几何算术：把分割带自身高度从容器里扣掉（夹限与 flexGrow 同口径）
    expect(SPLIT_CODE).toMatch(/rect\.height - band/)
    // 剥注释再断言：纯逻辑文件不许有 window / localStorage 调用（注释里提名字不算）
    expect(stripComments(MODEL_SOURCE)).not.toMatch(/window\.|localStorage\./)
  })
})

describe('index.tsx 的比例状态与持久化', () => {
  it('两半 flexGrow 来源：上半 1-ratio、下半 ratio，flex-basis 0 在样式类里', () => {
    expect(INDEX_CODE).toMatch(/className="right-half" style=\{\{ flexGrow: 1 - ratio \}\}/)
    expect(INDEX_CODE).toMatch(/className="right-half" style=\{\{ flexGrow: ratio \}\}/)
    expect(INDEX_CODE.match(/className="right-half"/g)).toHaveLength(2)
    expect(INDEX_CODE).not.toMatch(/flexBasis/)
  })

  it('分割线插在两半之间，r 状态提升在 index（惰性初始化读一次存储）', () => {
    const topAt = INDEX_CODE.indexOf('<div className="right-half" style={{ flexGrow: 1 - ratio }}>')
    const splitAt = INDEX_CODE.indexOf('<RightSplit')
    const bottomAt = INDEX_CODE.indexOf('<div className="right-half" style={{ flexGrow: ratio }}>')
    expect(topAt).toBeGreaterThan(-1)
    expect(splitAt).toBeGreaterThan(topAt)
    expect(bottomAt).toBeGreaterThan(splitAt)
    expect(INDEX_CODE).toMatch(/useState<number>\(\(\) =>\s*\n?\s*parseSplit\(window\.localStorage\.getItem\(SPLIT_STORAGE_KEY\)\)\s*\n?\s*\)/)
  })

  it('localStorage 读写各一处：getItem 只在初始化，setItem 只在 commitSplit（pointerup 落盘）', () => {
    expect(INDEX_CODE.match(/localStorage\.getItem\(/g)).toHaveLength(1)
    expect(INDEX_CODE.match(/localStorage\.setItem\(/g)).toHaveLength(1)
    expect(INDEX_CODE).toMatch(/commitSplit[\s\S]*localStorage\.setItem\(SPLIT_STORAGE_KEY, serializeSplit\(r\)\)/)
  })
})

describe('CSS：比例模型', () => {
  it('两半 flex-basis 0 + min-height 0（不用百分比 basis，分割线高度不搅乱比例）', () => {
    const half = ruleBody(TASKS_CSS, '.right-half {')
    expect(half).toMatch(/flex-basis:\s*0/)
    expect(half).toMatch(/min-height:\s*0/)
    expect(half).not.toMatch(/%/)
  })

  it('分割线：命中区 8px、row-resize、无文字', () => {
    const split = ruleBody(TASKS_CSS, '.right-split {')
    expect(split).toMatch(/height:\s*8px/)
    expect(split).toMatch(/cursor:\s*row-resize/)
    expect(split).toMatch(/touch-action:\s*none/)
  })

  it('③④ 吃下半块剩余（flex: 1 1 auto + min-height: 0），不再有任何定高', () => {
    const points = ruleBody(POINTS_CSS, '.points-panel {')
    expect(points).toMatch(/flex:\s*1 1 auto/)
    expect(points).toMatch(/min-height:\s*0/)
    expect(points).not.toMatch(/flex:\s*0 0 \d+px/)
    const dayview = ruleBody(CALENDAR_CSS, '.calendar-dayview {')
    expect(dayview).toMatch(/flex:\s*1 1 auto/)
    expect(dayview).toMatch(/min-height:\s*0/)
    expect(dayview).not.toMatch(/flex:\s*0 0 \d+px/)
  })
})

describe('v0.28 定高口径删净', () => {
  it('348 字样在 src 全树 0 命中（词边界匹配，348160 这类无关数字不算）', () => {
    const hits = walk(resolve(ROOT, 'src'))
      .filter(file => /\b348\b/.test(readFileSync(file, 'utf8')))
      .map(file => file.slice(ROOT.length + 1).replace(/\\/g, '/'))
    expect(hits).toEqual([])
  })
})
