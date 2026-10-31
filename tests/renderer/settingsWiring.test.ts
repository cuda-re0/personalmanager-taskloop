import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 设置抽屉的结构不变量（v0.44）。
 *
 * 项目没有 DOM 测试栈（`tests/renderer` 一律是纯函数 + 源码断言），所以「界面上只许出现
 * 那 26 个串」「不许有 placeholder / 空态文案 / 引导语」这类纪律只能在源码层面钉住。
 * 纯逻辑在 `settingsModel.test.ts`。
 *
 * 断言一律先剥注释：本文件里很多「不许出现 X」的判据，而注释里可能恰好写着 X 这个名字。
 */

const ROOT = process.cwd()
const SETTINGS_DIR = 'src/renderer/main/features/settings'

const stripComments = (source: string): string =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const read = (rel: string): string => stripComments(readFileSync(resolve(ROOT, rel), 'utf8'))

/** 取 CSS 规则体（到第一个 `}` 为止） */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(selector)
  expect(start, selector).toBeGreaterThan(-1)
  return css.slice(start).split('}')[0]
}

/** JSX 里 `>` 与 `<` 之间的可见文字 */
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

/** 源码里的字符串字面量（单引号 / 双引号 / 反引号） */
function stringLiterals(source: string): string[] {
  const out: string[] = []
  const pattern = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return out
}

const CJK = /[\u4e00-\u9fa5]/

const DRAWER = read(`${SETTINGS_DIR}/SettingsDrawer.tsx`)
const DATA = read(`${SETTINGS_DIR}/useSettingsData.ts`)
const MODEL = read(`${SETTINGS_DIR}/settingsModel.ts`)
const CSS = readFileSync(resolve(ROOT, `${SETTINGS_DIR}/settings.css`), 'utf8')
const HEADER = read('src/renderer/main/components/AppHeader.tsx')
const INDEX = read('src/renderer/main/index.tsx')

/**
 * 04 §1 的白名单（本单 §3 表格逐串抄下来）。
 *
 * 两个 `aria-label`（`新的记忆` / `记忆类型`）是 §5.4 指定的——它们不可见，
 * 但确实是本文件里的中文字面量，所以一并登记。
 */
const ALLOWED = new Set([
  '设置',
  '关闭',
  '人物卡',
  '记忆',
  'AI',
  '名字',
  '怎么称呼我',
  '人设',
  '语气',
  '温柔',
  '直率',
  '活泼',
  '保存',
  '已保存',
  '身份',
  '偏好',
  '事实',
  '自动',
  '手动',
  '删除',
  '添加',
  '任务模型',
  '聊天模型',
  'API Key',
  '已配置',
  '未配置',
  '新的记忆',
  '记忆类型'
])

/** 设置目录下所有文件（含 css） */
function settingsFiles(): { rel: string; body: string }[] {
  const dir = resolve(ROOT, SETTINGS_DIR)
  return readdirSync(dir)
    .filter(name => statSync(join(dir, name)).isFile())
    .map(name => ({ rel: `${SETTINGS_DIR}/${name}`, body: read(`${SETTINGS_DIR}/${name}`) }))
}

describe('文案白名单（本单 §3：一个标点都不许多）', () => {
  it('SettingsDrawer 里出现的每一处中文都在白名单内（字面量 + JSX 可见文字）', () => {
    const found = new Set(
      [...stringLiterals(DRAWER), ...jsxText(DRAWER)].filter(text => CJK.test(text))
    )
    const offenders = [...found].filter(text => !ALLOWED.has(text))
    expect(offenders).toEqual([])
    // 反向兜底：白名单不许只剩空壳（一块都没渲染说明断言写错了文件）
    expect(found.size).toBeGreaterThan(10)
  })

  it('不写空态 / 加载中 / 引导语（这几类词一个都不许有）', () => {
    expect(DRAWER).not.toMatch(/暂无|还没有|加载中|点击|说明|提示/)
  })
})

describe('输入框纪律', () => {
  it('抽屉、数据、顶栏三处 placeholder 均 0 命中', () => {
    for (const source of [DRAWER, DATA, HEADER]) expect(source).not.toMatch(/placeholder/)
  })

  it('设置目录不含 清空 / 全部删除 / 重置（02 §3.8 的禁止项）', () => {
    for (const file of settingsFiles()) {
      expect(file.body, file.rel).not.toMatch(/清空|全部删除|重置/)
    }
  })
})

describe('接线', () => {
  it('顶栏有 `设置` 按钮，主入口挂上了 `<SettingsDrawer`', () => {
    expect(HEADER).toContain('设置')
    expect(INDEX).toContain('<SettingsDrawer')
  })

  it('展示组件不直连 IPC：SettingsDrawer 里 window.api 0 命中', () => {
    expect(DRAWER).not.toContain('window.api')
  })

  it('抽屉宽度 420px（最小窗宽 980，永远放得下）', () => {
    expect(ruleBody(CSS, '.settings-drawer')).toContain('width: 420px')
  })

  it('三张 label 表定义在 settingsModel 里，展示组件不另抄一份', () => {
    expect(MODEL).toContain('TONE_LABEL')
    expect(MODEL).toContain('KIND_LABEL')
    expect(MODEL).toContain('SOURCE_LABEL')
    expect(DRAWER).toContain('TONE_LABEL[tone]')
    expect(DRAWER).toContain('KIND_LABEL[memory.kind]')
    expect(DRAWER).toContain('SOURCE_LABEL[memory.source]')
  })
})
