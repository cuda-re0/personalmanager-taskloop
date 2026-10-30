import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * HUD 两页结构 / 文案白名单 / 背景合成（04 §5.3 / §5.4 v0.30）。
 *
 * 项目没有 DOM 测试栈，组件与样式纪律一律用源码断言钉住（参照 rightSplitWiring 的源码结构法）：
 *
 * 1. 两页：`今天` / `设置` 两个 tab，设置页三项齐全，**没有第三页**。
 * 2. 文案白名单：JSX 里的可见中文只有 `今天 设置 背景颜色 透明度 关闭悬浮窗`；
 *    `● N/M` / `今日 +N` / 任务标题 / 错误原文都是动态值，不在这里出现。
 * 3. v0.21 的形态删净：`contextmenu` / `dock-bar` / `float-pod` / `setExpanded` / `hud.expanded`
 *    在 src 全树 0 命中（先剥注释：注释里提到旧形态名不算）。
 * 4. 背景：`--hud-bg` 由 `rgba()` 合成，**不是**给容器加 `opacity`。
 */

const ROOT = process.cwd()

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

/** 剥掉注释再断言：注释不是可见文字，别让文档注释误伤「0 命中」类断言 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 取 CSS 规则体（到第一个 `}` 为止） */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start, selector).toBeGreaterThan(-1)
  return css.slice(start).split('}')[0]
}

/** 递归收集目录下所有文件 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const PANEL = stripComments(read('src/renderer/hud/HudPanel.tsx'))
const SETTINGS = stripComments(read('src/renderer/hud/HudSettings.tsx'))
const BALL = stripComments(read('src/renderer/hud/HudBall.tsx'))
const INDEX = stripComments(read('src/renderer/hud/index.tsx'))
const DATA = stripComments(read('src/renderer/hud/useHudData.ts'))
const MODEL = stripComments(read('src/renderer/hud/hudModel.ts'))
const HEADER = stripComments(read('src/renderer/main/components/AppHeader.tsx'))
const CSS = read('src/renderer/hud/hud.css')

/** JSX 里可见的文字节点（`>…<` 之间的内容） */
function jsxText(source: string): string[] {
  const out: string[] = []
  const pattern = />([^<>{}]*)</g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const text = match[1].trim()
    if (text.length > 0) out.push(text)
  }
  return out
}

describe('两页结构（今天 / 设置）', () => {
  it('头部两个 tab：今天 / 设置，tab 状态只有 today | settings', () => {
    expect(PANEL).toMatch(/type HudTab = 'today' \| 'settings'/)
    expect(PANEL.match(/className=\{tab === 'today'/g)).toHaveLength(1)
    expect(PANEL.match(/className=\{tab === 'settings'/g)).toHaveLength(1)
    expect(PANEL.match(/setTab\('today'\)/g)).toHaveLength(1)
    expect(PANEL.match(/setTab\('settings'\)/g)).toHaveLength(1)
  })

  it('今天页：列表在上、一句话加任务在列表下方（不是贴顶横条）', () => {
    const listAt = PANEL.indexOf('<ul className="hud-list">')
    const addAt = PANEL.indexOf('<HudAddTask')
    expect(listAt).toBeGreaterThan(-1)
    expect(addAt).toBeGreaterThan(listAt)
    // 输入行是面板 flex 流里的一块（普通行），不是绝对定位/浮层
    const add = ruleBody(CSS, '.hud-add {')
    expect(add).not.toMatch(/position:\s*(fixed|absolute)/)
  })

  it('设置页渲染在第二个 tab 分支里（没有第四项、没有第三页）', () => {
    expect(PANEL).toMatch(/<HudSettings data=\{data\} \/>/)
    expect(SETTINGS.match(/className="hud-field"/g)).toHaveLength(2)
    expect(SETTINGS.match(/输入|说明|重置|提示/g)).toBeNull()
  })

  it('设置页三项：颜色 / 透明度 0.3–1 step 0.05 / 关闭悬浮窗', () => {
    expect(SETTINGS).toMatch(/type="color"/)
    expect(SETTINGS).toMatch(/type="range"/)
    expect(SETTINGS).toMatch(/min=\{0\.3\}/)
    expect(SETTINGS).toMatch(/max=\{1\}/)
    expect(SETTINGS).toMatch(/step=\{0\.05\}/)
    expect(SETTINGS).toMatch(/data\.actions\.setBackground/)
    expect(SETTINGS).toMatch(/data\.actions\.setOpacity/)
    expect(SETTINGS).toMatch(/data\.actions\.close\(\)/)
    // 关闭悬浮窗 → hud.setVisible({visible:false})
    expect(DATA).toMatch(/setVisible\(\{ visible: false \}\)/)
  })
})

describe('文案白名单（04 §5.3：本节即白名单）', () => {
  it('JSX 可见文字只有 今天 设置 背景颜色 透明度 关闭悬浮窗', () => {
    const text = jsxText(PANEL)
      .concat(jsxText(SETTINGS), jsxText(BALL), jsxText(INDEX))
      .filter(t => /[\u4e00-\u9fa5]/.test(t))
    expect(new Set(text)).toEqual(new Set(['今天', '设置', '背景颜色', '透明度', '关闭悬浮窗']))
  })

  it('不写空态文案、不加说明与 tooltip（title=）', () => {
    for (const source of [PANEL, SETTINGS, BALL]) {
      expect(source).not.toMatch(/\btitle=/)
      expect(source).not.toMatch(/暂无|没有任务|点击|说明/)
    }
  })
})

describe('v0.21 形态删净（全树 0 命中）', () => {
  it('src 全树搜不到 dock-bar / float-pod / hud 的 setExpanded / hud.expanded / contextmenu', () => {
    // 只认 hud 的 setExpanded（主窗自己有同名的本地 setter，不属于本单）
    const offenders = [
      'dock-bar',
      'float-pod',
      'hud.setExpanded',
      'hud:setExpanded',
      'hudSetExpanded',
      'hud.expanded',
      'contextmenu'
    ]
    const hits: string[] = []
    for (const file of walk(resolve(ROOT, 'src'))) {
      const body = stripComments(readFileSync(file, 'utf8'))
      for (const word of offenders) {
        if (body.includes(word)) hits.push(`${file.slice(ROOT.length + 1)} → ${word}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('DockBar.tsx / FloatPod.tsx 已删除，按 mode 渲染 Ball / Panel', () => {
    expect(existsSync(resolve(ROOT, 'src/renderer/hud/DockBar.tsx'))).toBe(false)
    expect(existsSync(resolve(ROOT, 'src/renderer/hud/FloatPod.tsx'))).toBe(false)
    expect(INDEX).toMatch(/data\.mode === 'ball' \? <HudBall data=\{data\} \/> : <HudPanel data=\{data\} \/>/)
  })
})

describe('背景与透明度（04 §5.4）', () => {
  it('--hud-bg 由 rgba() 合成，alpha 就是 hud.opacity', () => {
    expect(MODEL).toMatch(/return `rgba\(\$\{rgb\.r\}, \$\{rgb\.g\}, \$\{rgb\.b\}, \$\{alpha\}\)`/)
    expect(DATA).toMatch(/composeHudBg\(/)
    expect(PANEL).toMatch(/style=\{\{ '--hud-bg': data\.hudBg \}/)
    expect(BALL).toMatch(/style=\{\{ '--hud-bg': data\.hudBg \}/)
  })

  it('长条与面板的 background 都用 var(--hud-bg)，进度环轨道走 --border', () => {
    expect(ruleBody(CSS, '.hud-panel {')).toMatch(/background:\s*var\(--hud-bg\)/)
    expect(ruleBody(CSS, '.hud-ball {')).toMatch(/background:\s*var\(--hud-bg\)/)
    expect(ruleBody(CSS, '.hud-bar-track {')).toMatch(/stroke:\s*var\(--border\)/)
  })

  it('容器上没有任何 opacity（文字不会跟着变淡）', () => {
    const withoutComments = stripComments(CSS)
    expect(withoutComments).not.toMatch(/(^|[^-])opacity\s*:/)
  })
})

describe('长条态（v0.31：132×40 胶囊 / 拖 vs 点）', () => {
  it('长条铺满窗口：胶囊圆角 999px', () => {
    expect(ruleBody(CSS, '.hud-ball {')).toMatch(/width:\s*100%/)
    expect(ruleBody(CSS, '.hud-ball {')).toMatch(/height:\s*100%/)
    expect(ruleBody(CSS, '.hud-ball {')).toMatch(/border-radius:\s*999px/)
  })

  it('内容三段：环 / 完成数比 / 星期，另铺一层整条热区', () => {
    for (const cls of ['hud-bar-ring', 'hud-bar-ratio', 'hud-bar-week', 'hud-hit']) {
      expect(BALL).toContain(cls)
    }
    expect(ruleBody(CSS, '.hud-hit {')).toMatch(/inset:\s*0/)
    expect(BALL).toMatch(/weekdayLabel\(new Date\(\)\)/)
    expect(BALL).toMatch(/ratioLabel\(data\.done, data\.total\)/)
    expect(BALL).toMatch(/data\.actions\.setMode\('panel'\)/)
  })

  it('v0.30 的 56px 圆球痕迹删净：旧常量全树 0 命中', () => {
    // 拆开拼：自检的 grep 要能 0 命中，本用例自己不该成为命中点
    const offenders = ['BALL' + '_SIZE', 'PEEK' + '_GAP', 'EDGE' + '_COLLAPSE']
    const hits: string[] = []
    for (const file of walk(resolve(ROOT, 'src')).concat(walk(resolve(ROOT, 'tests')))) {
      if (file.endsWith('hudWiring.test.ts')) continue // 本用例自己写着这三个词
      const body = stripComments(readFileSync(file, 'utf8'))
      for (const word of offenders) {
        if (body.includes(word)) hits.push(`${file.slice(ROOT.length + 1)} → ${word}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('面板 ESC 收回长条；头部是拖动把手，tab 是 no-drag', () => {
    expect(PANEL).toMatch(/event\.key === 'Escape'/)
    expect(PANEL).toMatch(/setMode\('ball'\)/)
    expect(ruleBody(CSS, '.hud-head {')).toMatch(/-webkit-app-region:\s*drag/)
    expect(ruleBody(CSS, '.hud-tabs {')).toMatch(/-webkit-app-region:\s*no-drag/)
    expect(ruleBody(CSS, '.hud-panel {')).toMatch(/height:\s*100%/)
  })
})

describe('长条手势（v0.32：点按展开 / 长按拖动）', () => {
  it('整条不再用原生 drag：.hud-ball / .hud-hit 里都没有 app-region', () => {
    expect(ruleBody(CSS, '.hud-ball {')).not.toMatch(/-webkit-app-region/)
    expect(ruleBody(CSS, '.hud-hit {')).not.toMatch(/-webkit-app-region/)
    // drag 只剩面板头部那一处（tab 与设置页的 no-drag 是它的子元素，得留着）
    expect((CSS.match(/-webkit-app-region:\s*drag/g) ?? []).length).toBe(1)
  })

  it('手势走 pointer 事件 + 指针捕获，点击只由 pointerup 判定（没有 onClick）', () => {
    for (const handler of [
      'onPointerDown',
      'onPointerMove',
      'onPointerUp',
      'onPointerCancel',
      'setPointerCapture'
    ]) {
      expect(BALL).toContain(handler)
    }
    expect(BALL).not.toMatch(/\bonClick=/)
    // 位移取屏幕坐标差值（窗口自己在动，clientX 会漂）
    expect(BALL).toMatch(/e\.screenX/)
    expect(BALL).toMatch(/e\.screenY/)
    // 一帧最多一次 IPC
    expect(BALL).toMatch(/requestAnimationFrame/)
    // 绝对定位：先取左上角算抓取偏移，再发绝对坐标；增量模型已删
    expect(BALL).toMatch(/dragBegin\(\)/)
    expect(BALL).toMatch(/dragTo\(\{ x: point\.x, y: point\.y, end \}\)/)
    expect(BALL).not.toContain('drag' + 'By')
  })

  it('长条侧没有自定义鼠标样式（系统默认），is-dragging 那套已删', () => {
    expect(ruleBody(CSS, '.hud-ball {')).not.toMatch(/cursor/)
    expect(ruleBody(CSS, '.hud-hit {')).not.toMatch(/cursor/)
    // 全文件不许再出现 grab / grabbing（面板侧原有的 cursor: pointer 不动）
    expect(CSS).not.toMatch(/grabbing/)
    expect(CSS).not.toMatch(/cursor:\s*grab\b/)
    expect(BALL).not.toMatch(/cursor/)
    expect(BALL).not.toMatch(/is-dragging/)
  })

  it('阈值常量在 hudModel 里，不写死在组件里', () => {
    expect(MODEL).toMatch(/export const LONG_PRESS_MS = 260/)
    expect(MODEL).toMatch(/export const TAP_TOLERANCE = 4/)
    expect(BALL).toMatch(/LONG_PRESS_MS/)
    expect(BALL).toMatch(/TAP_TOLERANCE/)
  })

  it('面板最窄也有可抓的空白：.hud-grow 留 24px 底宽', () => {
    expect(ruleBody(CSS, '.hud-grow {')).toMatch(/min-width:\s*24px/)
  })

  it('固定阈值常量删净：全树 0 命中（改成工作区宽度 1/8 的换算）', () => {
    // 拆开拼：自检的 grep 要 0 命中，本用例自己不该成为命中点
    const word = 'EDGE' + '_EXPAND'
    const hits: string[] = []
    for (const file of walk(resolve(ROOT, 'src')).concat(walk(resolve(ROOT, 'tests')))) {
      if (file.endsWith('hudWiring.test.ts')) continue
      if (readFileSync(file, 'utf8').includes(word)) hits.push(file.slice(ROOT.length + 1))
    }
    expect(hits).toEqual([])
  })
})

describe('可见性同步（v0.31 / 原 kickoff 29）', () => {
  it('顶栏订阅 hud.visible.changed 并取消订阅（只看不写回，避免自激）', () => {
    expect(HEADER).toMatch(/event\.type === 'hud\.visible\.changed'/)
    expect(HEADER).toMatch(/setVisible\(event\.visible\)/)
    expect(HEADER).toMatch(/return off/)
    // 订阅回调里不许再调 hud.setVisible 写回主进程（会「广播 → 再 setVisible → 再广播」自激）
    const from = HEADER.indexOf('window.api.onEvent(event =>')
    expect(from).toBeGreaterThan(-1)
    const callback = HEADER.slice(from, HEADER.indexOf('}, [])', from))
    expect(callback).not.toMatch(/setVisible\(\{/)
  })

  it('事件表里登记了 hud.visible.changed', () => {
    expect(read('src/shared/types/events.ts')).toContain(
      "{ type: 'hud.visible.changed'; visible: boolean }"
    )
  })
})

describe('完成与错误（04 §5.3）', () => {
  it('每日走 occurrence.complete、限时可完成走 transition → task.complete', () => {
    expect(DATA).toMatch(/occurrence\s*\.complete\(\{ id: row\.id \}\)/)
    expect(DATA).toMatch(/transition\(\{ id: row\.id, to: 'reviewing' \}\)/)
    expect(DATA).toMatch(/task\.complete\(\{ id: row\.id, quality: 'met' \}\)/)
  })

  it('失败在行内显示 AppError.message 原文，4s 消失', () => {
    expect(DATA).toMatch(/ERROR_TTL_MS = 4000/)
    expect(DATA).toMatch(/setRowError\(\{ rowId, message \}\)/)
    expect(PANEL).toMatch(/hud-row-error/)
    expect(ruleBody(CSS, '.hud-row-error {')).toMatch(/color:\s*var\(--danger\)/)
  })
})
