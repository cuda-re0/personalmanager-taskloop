import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 日历层（04 §4② v0.28）结构不变量：点天 → ③④ 积分面板整块被日历层就地替换；
 * 再点同一天关闭回积分面板；行点击只高亮不关闭；完成情况只用勾的形状承载。
 */

const INDEX_SOURCE = readFileSync(resolve(process.cwd(), 'src/renderer/main/index.tsx'), 'utf8')

const DAYVIEW_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/CalendarDayView.tsx'),
  'utf8'
)

const HOOK_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/useCalendarData.ts'),
  'utf8'
)

const POINTS_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/points/points.css'),
  'utf8'
)

const CALENDAR_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/calendar/calendar.css'),
  'utf8'
)

const TASKS_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/tasks/tasks.css'),
  'utf8'
)

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start, selector).toBeGreaterThan(-1)
  return css.slice(start).split('}')[0]
}

/** 剥掉注释再断言：注释不是可见文字，别让文档注释误伤「无文字」类断言 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('③④ 槽位二选一（index.tsx）', () => {
  it('选中日提升为 index 的状态，PointsPanel / CalendarDayView 按它条件渲染', () => {
    expect(INDEX_SOURCE).toMatch(
      /const \[dayDetail, setDayDetail\] = useState<string \| null>\(null\)/
    )
    expect(INDEX_SOURCE).toMatch(
      /dayDetail \? <CalendarDayView day=\{dayDetail\} \/> : <PointsPanel \/>/
    )
  })

  it('再点同一天 = 关闭（toggle 置 null）、点其他天 = 切换', () => {
    expect(INDEX_SOURCE).toMatch(/setDayDetail\(prev => \(prev === day \? null : day\)\)/)
  })
})

describe('右栏框架固定（04 §4① v0.28）', () => {
  it('积分区定高配额 348px（实测详情收起态锁定），日历层沿用同一配额', () => {
    const points = ruleBody(POINTS_CSS, '.points-panel {')
    expect(points).toMatch(/flex:\s*0 0 348px/)
    expect(points).not.toMatch(/flex:\s*1 1 auto/)
    const dayview = ruleBody(CALENDAR_CSS, '.calendar-dayview {')
    expect(dayview).toMatch(/flex:\s*0 0 348px/)
  })

  it('① 任务区吃剩余空间且不许挤压别人（min-height: 0 + 内部滚动）', () => {
    const tasks = ruleBody(TASKS_CSS, '.tasks-panel {')
    expect(tasks).toMatch(/min-height:\s*0/)
    expect(tasks).toMatch(/overflow-y:\s*auto/)
  })
})

// 注释剥掉后再断言：文案纪律管的是可见文字
const dayViewCode = stripComments(DAYVIEW_SOURCE)

describe('日历层组件（CalendarDayView）', () => {
  it('行 = 完成勾 + 标题：勾复用 ① 的样式类，pending 空心 / done 实心', () => {
    expect(dayViewCode).toMatch(/row\.done \? 'task-check task-check--on' : 'task-check'/)
    // 映射在 useCalendarData 的纯函数里：pending/done 之外的行不显示
    expect(HOOK_SOURCE).toMatch(/filter\(o => o\.status === 'pending' \|\| o\.status === 'done'\)/)
    expect(HOOK_SOURCE).toMatch(/done: o\.status === 'done'/)
  })

  it('完成情况只用图形：可见文字里没有「已完成/未完成/暂无任务」', () => {
    expect(dayViewCode).not.toMatch(/已完成|未完成|完成情况|暂无任务/)
  })

  it('点行只高亮不关闭：派发 focus-task，且不碰选中状态', () => {
    expect(dayViewCode).toMatch(/taskloop:focus-task/)
    expect(dayViewCode).not.toMatch(/onSelectDay|setDayDetail/)
  })

  it('头部只有日期标题，没有 × 关闭按钮', () => {
    expect(dayViewCode).toMatch(/calendar-dayview-head/)
    expect(dayViewCode).not.toMatch(/aria-label="关闭"/)
    expect(dayViewCode).not.toMatch(/×/)
  })
})

const hookCode = stripComments(HOOK_SOURCE)

describe('零请求原则（没选日子不发请求）', () => {
  it('listByRange 调用点唯一，且在 useDayOccurrences 的挂载 effect 里', () => {
    // hook 只被 CalendarDayView 调用（该组件仅在 dayDetail 非空时渲染），没挂载就没有调用
    expect(hookCode.match(/\.listByRange\(/g)).toHaveLength(1)
    expect(hookCode).toMatch(/useEffect\(\(\) => \{[\s\S]*?\.listByRange\(/)
    expect(hookCode).toMatch(/\}, \[day, rev\]\)/)
    expect(dayViewCode).toMatch(/useDayOccurrences\(day\)/)
  })
})
