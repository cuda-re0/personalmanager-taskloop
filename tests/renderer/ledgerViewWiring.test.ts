import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ④ 明细视图（04 §4④ v0.26）的结构不变量。
 *
 * 项目没有 DOM 测试栈（`tests/renderer` 一律是纯函数 + 源码断言），而本单有几条
 * 只在源码层面才看得出来的纪律：组件里不许做日期算术、界面不许有撤销入口、
 * 明细只在选中时才挂载（= 才发请求）、整窗明细页的机制必须彻底消失。纯逻辑在 `ledgerModel.test.ts`。
 *
 * 断言一律先剥注释：本文件里很多"不许出现 X"的判据，而注释里可能恰好写着 X 这个名字。
 */

const ROOT = process.cwd()

const stripComments = (source: string): string =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** 源码压成一行（连续空白折成一个空格），便于写跨行的 toMatch */
const flat = (source: string): string => source.replace(/\s+/g, ' ')

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

const LEDGER_VIEW = read('src/renderer/main/features/points/LedgerView.tsx')
const USE_LEDGER_VIEW = read('src/renderer/main/features/points/useLedgerView.ts')
const POINTS_PANEL = read('src/renderer/main/features/points/PointsPanel.tsx')
const USE_POINTS_DATA = read('src/renderer/main/features/points/usePointsData.ts')
const MAIN_INDEX = read('src/renderer/main/index.tsx')
const TASKS_CSS = read('src/renderer/main/features/tasks/tasks.css')
const POINTS_CSS = read('src/renderer/main/features/points/points.css')
const CHAT_CSS = read('src/renderer/shared/styles/chat.css')
const WINDOW_MANAGER = read('src/main/windowManager.ts')

const VIEW_CODE = flat(stripComments(LEDGER_VIEW))
const USE_VIEW_CODE = flat(stripComments(USE_LEDGER_VIEW))
const PANEL_CODE = flat(stripComments(POINTS_PANEL))
const USE_POINTS_CODE = flat(stripComments(USE_POINTS_DATA))
const INDEX_CODE = flat(stripComments(MAIN_INDEX))

/** `src` 下所有文件（不引依赖，手写递归） */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

describe('明细视图组件：日期算术只在纯函数里（口径 3）', () => {
  it('LedgerView.tsx 里没有 new Date / getMonth / setDate', () => {
    expect(VIEW_CODE).not.toMatch(/new Date|getMonth|setDate|getUTCDate|Date\.parse/)
  })

  it('整份 points 目录的 .tsx 都不做日期算术', () => {
    const dir = resolve(ROOT, 'src/renderer/main/features/points')
    for (const file of walk(dir).filter(f => f.endsWith('.tsx'))) {
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(code, relative(ROOT, file)).not.toMatch(/new Date|getMonth|setDate|getUTCDate/)
    }
  })

  it('月导航与行上的文字全部来自模型导出，组件不拼字符串', () => {
    for (const token of [
      'monthLabelOf(month)',
      'dayLabelOf(group.day)',
      'netLabel(net)',
      'timeLabel(entry.createdAt)',
      'formatSigned(entry.delta)'
    ]) {
      expect(VIEW_CODE, token).toContain(token)
    }
  })
})

describe('明细视图：面板内组件，不是整窗页（04 §4④ v0.26）', () => {
  it('没有页头、没有返回按钮', () => {
    expect(VIEW_CODE).not.toContain('返回')
    expect(VIEW_CODE).not.toContain('ledger-page')
    expect(VIEW_CODE).not.toContain('onBack')
  })

  it('`‹` `›` 两个切月按钮，当月时 `›` 真的 disabled', () => {
    expect(VIEW_CODE).toMatch(/> ‹ </)
    expect(VIEW_CODE).toMatch(/> › </)
    expect(VIEW_CODE).toContain('disabled={!canGoNext}')
    expect(VIEW_CODE).toContain('shiftMonth(-1)')
    expect(VIEW_CODE).toContain('shiftMonth(1)')
  })

  it('行可点：只有 taskId 非空才跳任务（不切视图、不滚整页）', () => {
    expect(VIEW_CODE).toContain('if (entry.taskId !== null) onOpenTask(entry.taskId)')
  })

  it('已冲销行整行降不透明度，不另加文字', () => {
    expect(VIEW_CODE).toContain('ledger-row ledger-row--reversed')
  })

  it('页面没有说明文字：不含任何中文字面量（日期/时刻/±N 都由模型拼）', () => {
    const visible = VIEW_CODE.replace(/aria-label="[^"]*"/g, '').replace(/className="[^"]*"/g, '')
    expect(visible.match(/[\u4e00-\u9fa5]+/g) ?? []).toEqual([])
  })
})

describe('④ 的四个标签（PointsPanel）', () => {
  it('三个范围标签 + `明细`，`明细` 排在最后', () => {
    expect(PANEL_CODE).toContain('RANGES.map')
    expect(PANEL_CODE).toContain('{RANGE_LABEL[item]}')
    expect(PANEL_CODE).toContain('{LEDGER_VIEW_LABEL}')
    expect(PANEL_CODE.indexOf('RANGES.map')).toBeLessThan(PANEL_CODE.indexOf('{LEDGER_VIEW_LABEL}'))
  })

  it('最右端不再有 `›` 图标按钮（v0.24 的入口已删）', () => {
    expect(PANEL_CODE).not.toContain('aria-label="明细"')
    expect(PANEL_CODE).not.toContain('points-open')
    expect(PANEL_CODE).not.toMatch(/> › </)
  })

  it('视图与范围是两套状态：点前三个标签 = 回平铺 + 切范围', () => {
    expect(PANEL_CODE).toContain("useState<PointsView>('list')")
    expect(PANEL_CODE).toMatch(
      /const showRange = \(target: LedgerRange\): void => \{ setView\('list'\) setRange\(target\) \}/
    )
    expect(PANEL_CODE).toContain('onClick={() => showRange(item)}')
  })

  it('选中明细才渲染 LedgerView，否则还是平铺流水', () => {
    expect(PANEL_CODE).toMatch(
      /view === 'ledger' \? \(\s*<LedgerView onOpenTask=\{emitFocusTask\} \/>\s*\)/
    )
    expect(PANEL_CODE).toContain('<ul className="ledger-list">')
    expect(PANEL_CODE).toContain("onClick={() => setView('ledger')}")
  })

  it('③ 积分在 ④ 之外，两种视图下都始终在（不在条件分支里）', () => {
    expect(PANEL_CODE).toContain('className="points-summary"')
    expect(PANEL_CODE.indexOf('points-summary')).toBeLessThan(PANEL_CODE.indexOf('points-ledger'))
    expect(PANEL_CODE).not.toMatch(/\?\s*\(\s*<section className="points-summary"/)
  })
})

describe('明细未选中时不发请求（口径 7）', () => {
  // 无 DOM 栈，只能锁形状：LedgerView 是条件渲染 → 它的 hook 随之挂载/卸载 → 请求时机由挂载决定
  it('LedgerView 只在 `view === ledger` 分支里出现一次', () => {
    expect(PANEL_CODE.match(/<LedgerView /g)?.length).toBe(1)
  })

  it('PointsPanel 自己不调 monthStats / 月流水（请求都在 LedgerView 的 hook 里）', () => {
    expect(PANEL_CODE).not.toContain('useLedgerView')
    expect(PANEL_CODE).not.toContain('window.api')
  })

  it('`points.ledger` 的月查询在 useLedgerView 的 effect 里，跟着挂载走', () => {
    expect(USE_VIEW_CODE).toContain('window.api.points.ledger({ from, to, limit: LEDGER_LIMIT })')
    expect(USE_VIEW_CODE).toContain('useEffect(() => { reload(month) }, [reload, month])')
  })
})

describe('整窗明细页机制已彻底删除（口径 1）', () => {
  it('index.tsx 不再有视图状态与切换函数', () => {
    for (const token of [
      'LedgerPage',
      'useLedgerPage',
      'openLedger',
      'backToWorkbench',
      'MainView',
      "useState<'workbench",
      'emitFocusTask'
    ]) {
      expect(INDEX_CODE, token).not.toContain(token)
    }
  })

  it('index.tsx 回到简单结构：列容器 + AppHeader + .app-shell，没有覆盖层', () => {
    expect(INDEX_CODE).not.toContain('visibility')
    expect(INDEX_CODE).not.toContain('pointerEvents')
    expect(INDEX_CODE).not.toContain('position: ')
    const headerAt = INDEX_CODE.indexOf('<AppHeader />')
    const shellAt = INDEX_CODE.indexOf('<div className="app-shell"')
    const chatAt = INDEX_CODE.indexOf('<ChatPanel />')
    expect(headerAt).toBeGreaterThan(0)
    expect(shellAt).toBeGreaterThan(headerAt)
    expect(chatAt).toBeGreaterThan(shellAt)
    for (const token of [
      '<aside className="right-col">',
      '<TasksPanel />',
      '<CalendarPanel selectedDay={dayDetail} onSelectDay={toggleDay} />',
      '<PointsPanel />'
    ]) {
      expect(INDEX_CODE, token).toContain(token)
    }
  })

  it('src/renderer 全树不含 task.undo / canUndoEntry / 撤销 任何一个字样（口径 2）', () => {
    const hits = walk(resolve(ROOT, 'src/renderer'))
      .filter(file => {
        const text = readFileSync(file, 'utf8')
        return /task\.undo|canUndoEntry|撤销/.test(text)
      })
      .map(file => relative(ROOT, file).replace(/\\/g, '/'))
    expect(hits).toEqual([])
  })

  it('④ 的数据 hook 不再有撤销动作与错误提示（悬念都随入口一起删）', () => {
    expect(USE_POINTS_CODE).not.toContain('undo')
    expect(USE_POINTS_CODE).not.toContain('notice')
  })

  it('主进程的撤销能力保留（界面没有了，通道与数据层不动）', () => {
    expect(read('src/main/services/taskService.ts')).toContain('undoCompletion')
    expect(read('src/main/ipc/registry.ts')).toContain('task.undo')
  })
})

describe('栏宽与最小窗口（口径 4）', () => {
  it('.right-col 三处都是 460px，没有残留 400px', () => {
    const block = TASKS_CSS.slice(
      TASKS_CSS.indexOf('.right-col {'),
      TASKS_CSS.indexOf('}', TASKS_CSS.indexOf('.right-col {'))
    )
    expect(block).toContain('flex: 0 0 460px')
    expect(block).toContain('width: 460px')
    expect(block).toContain('min-width: 460px')
    expect(block).not.toContain('400px')
  })

  it('会话区的 min-width 不许动：仍是 520px', () => {
    expect(CHAT_CSS).toContain('min-width: 520px')
  })

  it('主窗最小宽度同步到 980（460 + 520）', () => {
    expect(WINDOW_MANAGER).toContain('minWidth: 980')
    expect(WINDOW_MANAGER).not.toContain('minWidth: 940')
  })
})

describe('右侧留白 20px / 无横向滚动（口径 5、6）', () => {
  it('③ 与 tabs 行：右 20px、左 16px', () => {
    expect(POINTS_CSS).toMatch(/\.points-summary \{[^}]*padding: 12px 20px 12px 16px/)
    expect(POINTS_CSS).toMatch(/\.points-tabs \{[^}]*padding: 8px 20px 8px 16px/)
  })

  it('列表：容器右 12 + 行内 8 = 内容距右边缘 20px（左 8 + 8 = 16px）', () => {
    expect(POINTS_CSS).toMatch(/\.ledger-list \{[^}]*padding: 0 12px 12px 8px/)
    expect(POINTS_CSS).toMatch(/\.ledger-row \{[^}]*padding: 0 8px/)
    expect(POINTS_CSS).toMatch(/\.ledger-group-list \{[^}]*padding: 0 12px 0 8px/)
  })

  it('行内允许收缩（min-width: 0），不拿 overflow-x: hidden 掩盖溢出', () => {
    expect(POINTS_CSS).not.toContain('overflow-x')
    expect(POINTS_CSS).toMatch(/\.ledger-row \{[^}]*min-width: 0/)
    expect(POINTS_CSS).toMatch(/\.ledger-text \{[^}]*min-width: 0/)
  })

  it('滚动只发生在列表这一块：明细视图与 body 各一条 overflow-y', () => {
    expect(POINTS_CSS).toMatch(/\.ledger-list \{[^}]*overflow-y: auto/)
    expect(POINTS_CSS).toMatch(/\.ledger-body \{[^}]*overflow-y: auto/)
  })
})

describe('全项目只有一份 toLocalDay（口径 4）', () => {
  it('`function toLocalDay` 在 src 下只命中 src/shared/localDay.ts', () => {
    const hits = walk(resolve(ROOT, 'src'))
      .filter(file => readFileSync(file, 'utf8').includes('function toLocalDay'))
      .map(file => relative(ROOT, file).replace(/\\/g, '/'))
    expect(hits).toEqual(['src/shared/localDay.ts'])
  })
})
