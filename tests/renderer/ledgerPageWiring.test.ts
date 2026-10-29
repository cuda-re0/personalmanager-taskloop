import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 明细页（04 §4④ v0.24）的结构不变量。
 *
 * 项目没有 DOM 测试栈（`tests/renderer` 一律是纯函数 + 源码断言），而本单有三条
 * 只在源码层面才看得出来的纪律：组件里不许做日期算术、明细页不许出现撤销入口、
 * 切月的 `›` 必须真的 disabled。纯逻辑部分在 `ledgerModel.test.ts` 里。
 *
 * 断言一律先剥注释：本文件里很多"不许出现 X"的判据，而注释里恰好写着 X 这个名字。
 */

const ROOT = process.cwd()

const stripComments = (source: string): string =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** 源码压成一行（连续空白折成一个空格），便于写跨行的 toMatch */
const flat = (source: string): string => source.replace(/\s+/g, ' ')

const LEDGER_PAGE = readFileSync(
  resolve(ROOT, 'src/renderer/main/features/points/LedgerPage.tsx'),
  'utf8'
)
const POINTS_PANEL = readFileSync(
  resolve(ROOT, 'src/renderer/main/features/points/PointsPanel.tsx'),
  'utf8'
)
const MAIN_INDEX = readFileSync(resolve(ROOT, 'src/renderer/main/index.tsx'), 'utf8')

const LEDGER_CODE = flat(stripComments(LEDGER_PAGE))
const PANEL_CODE = flat(stripComments(POINTS_PANEL))
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

describe('明细页组件：日期算术只在纯函数里（口径 3）', () => {
  it('LedgerPage.tsx 里没有 new Date / getMonth / setDate', () => {
    expect(LEDGER_CODE).not.toMatch(/new Date|getMonth|setDate|getUTCDate|Date\.parse/)
  })

  it('整份 points 目录的 .tsx 都不做日期算术', () => {
    const dir = resolve(ROOT, 'src/renderer/main/features/points')
    for (const file of walk(dir).filter(f => f.endsWith('.tsx'))) {
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(code, relative(ROOT, file)).not.toMatch(/new Date|getMonth|setDate|getUTCDate/)
    }
  })

  it('页头与行上的文字全部来自模型导出，组件不拼字符串', () => {
    expect(LEDGER_CODE).toContain('monthLabelOf(month)')
    expect(LEDGER_CODE).toContain('dayLabelOf(group.day)')
    expect(LEDGER_CODE).toContain('netLabel(net)')
    expect(LEDGER_CODE).toContain('timeLabel(entry.createdAt)')
    expect(LEDGER_CODE).toContain('formatSigned(entry.delta)')
  })
})

describe('明细页组件：页头与行（04 §4④ v0.24）', () => {
  it('`‹` `›` 两个切月按钮，当月时 `›` 真的 disabled（口径 6 的 UI 侧）', () => {
    expect(LEDGER_CODE).toMatch(/> ‹ </)
    expect(LEDGER_CODE).toMatch(/> › </)
    expect(LEDGER_CODE).toContain('disabled={!canGoNext}')
    expect(LEDGER_CODE).toContain('shiftMonth(-1)')
    expect(LEDGER_CODE).toContain('shiftMonth(1)')
  })

  it('返回按钮带 aria-label="返回"，图标是 `←`', () => {
    expect(LEDGER_CODE).toMatch(/aria-label="返回" className="ledger-page-back"/)
    expect(LEDGER_CODE).toMatch(/> ← </)
  })

  it('行可点：只有 taskId 非空才跳任务，切视图由调用方负责', () => {
    expect(LEDGER_CODE).toContain('if (entry.taskId !== null) onOpenTask(entry.taskId)')
  })

  it('已冲销行整行降不透明度，不另加文字', () => {
    expect(LEDGER_CODE).toContain('ledger-page-row ledger-page-row--reversed')
  })

  it('明细页没有撤销入口（撤销只在右栏 ④）', () => {
    expect(LEDGER_CODE).not.toContain('撤销')
    expect(LEDGER_CODE).not.toContain('task.undo')
  })

  it('页面没有说明文字：不含任何中文字面量（日期/时刻/±N 都由模型拼）', () => {
    const visible = LEDGER_CODE.replace(/aria-label="[^"]*"/g, '').replace(/className="[^"]*"/g, '')
    expect(visible.match(/[\u4e00-\u9fa5]+/g) ?? []).toEqual([])
  })
})

describe('右栏 ④ 的入口（04 §4④ v0.24）', () => {
  it('tabs 行最右端有一个 aria-label="明细" 的 `›`', () => {
    expect(PANEL_CODE).toMatch(/aria-label="明细" className="points-open"/)
    expect(PANEL_CODE).toContain('onClick={onOpenLedger}')
    expect(PANEL_CODE).toMatch(/> › </)
  })

  it('④ 原有的东西全部保留：三个 tab、行尾撤销、就地提示', () => {
    for (const token of [
      'RANGE_LABEL',
      'points-tab',
      'canUndoEntry',
      'ledger-undo',
      'points-notice'
    ]) {
      expect(POINTS_PANEL, token).toContain(token)
    }
    expect(PANEL_CODE).toMatch(/RANGES\.map/)
  })

  it('入口是图标不是文案：面板里没有「查看全部」这类字', () => {
    expect(PANEL_CODE).not.toContain('查看全部')
    expect(PANEL_CODE).not.toContain('全部')
  })
})

describe('视图切换（src/renderer/main/index.tsx）', () => {
  it('视图状态就两个值，初值是 workbench', () => {
    expect(INDEX_CODE).toContain("useState<MainView>('workbench')")
    expect(INDEX_CODE).toContain("type MainView = 'workbench' | 'ledger'")
  })

  it('顶栏在分支之外：两种视图都保留（HUD 开关不能被藏掉）', () => {
    const headerAt = INDEX_CODE.indexOf('<AppHeader />')
    const shellAt = INDEX_CODE.indexOf('<div className="app-shell"')
    expect(headerAt).toBeGreaterThan(0)
    expect(shellAt).toBeGreaterThan(headerAt)
  })

  // v0.25 返工的核心：工作台不许被卸载（草稿/附件/发送中/滚动位置都在组件状态里）
  it("工作台不在任何条件分支里：没有 `view === 'workbench' ?`，也不是 && 的右操作数", () => {
    expect(INDEX_CODE).not.toContain("view === 'workbench' ?")
    expect(INDEX_CODE).not.toMatch(/\?\s*\(\s*<div className="app-shell"/)
    expect(INDEX_CODE).not.toMatch(/&&\s*\(\s*<div className="app-shell"/)
  })

  it('三条挂载原样保留在工作台里（ChatPanel 在 app-shell 之内）', () => {
    const shellAt = INDEX_CODE.indexOf('<div className="app-shell"')
    const chatAt = INDEX_CODE.indexOf('<ChatPanel />')
    expect(shellAt).toBeGreaterThan(0)
    expect(chatAt).toBeGreaterThan(shellAt)
    for (const token of [
      '<aside className="right-col">',
      '<TasksPanel />',
      '<CalendarPanel />',
      '<PointsPanel onOpenLedger={openLedger} />'
    ]) {
      expect(INDEX_CODE, token).toContain(token)
    }
  })

  it('隐藏靠受 view 控制的内联 style，且不用 hidden 属性（类选择器会盖掉它）', () => {
    expect(INDEX_CODE).not.toContain('hidden=')
    expect(INDEX_CODE).toContain("visibility: view === 'ledger' ? 'hidden' : 'visible'")
    expect(INDEX_CODE).toContain("pointerEvents: view === 'ledger' ? 'none' : 'auto'")
    // display:none 会让滚动容器失去布局、scrollTop 归零，所以明确不许走那条
    expect(INDEX_CODE).not.toContain("display: view === 'ledger' ? 'none'")
  })

  it('明细页分支挂的是 LedgerPage，切换函数靠 props 传（不走 context）', () => {
    expect(INDEX_CODE).toContain('<LedgerPage onBack={backToWorkbench} onOpenTask={openTask} />')
    expect(INDEX_CODE).not.toContain('createContext')
  })

  it('点行跳回：同一次交互里切视图 + 同步派发 focus（工作台没卸载，不需要延后）', () => {
    expect(INDEX_CODE).toMatch(/setView\('workbench'\) emitFocusTask\(taskId\)/)
  })

  it('临时状态 pendingFocus 已删除（口径 5）', () => {
    expect(INDEX_CODE).not.toContain('pendingFocus')
    expect(INDEX_CODE).not.toContain('setPendingFocus')
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
