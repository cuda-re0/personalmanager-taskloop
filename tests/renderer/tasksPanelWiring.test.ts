import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 结构不变量：`TasksPanel.tsx` 里 `useTasksData()` 只准出现一次。
 *
 * 为什么用源码断言而不是渲染测试：项目没有 DOM 测试栈（`tests/renderer` 全是纯函数），
 * 而这条 bug 的本质就是「详情组件又调了一次 hook」——多实例后 `subtasksByParent` 是空的，
 * 带未勾步骤的任务点「完成」会绕过确认条直接计分完成（v0.20 修）。
 * 只要有人在详情里重新写 `const { actions } = useTasksData()`，这条就会红。
 */
const SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/tasks/TasksPanel.tsx'),
  'utf8'
)

const USE_TASKS_SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/main/features/tasks/useTasksData.ts'),
  'utf8'
)

/** submitAndComplete 那一段：完成链路的两个失败分支都在这里 */
const SUBMIT_SOURCE = USE_TASKS_SOURCE.slice(USE_TASKS_SOURCE.indexOf('const submitAndComplete'))

describe('TasksPanel 的 hook 实例纪律', () => {
  it('useTasksData() 只调用一次（多实例会让确认条永远弹不出来）', () => {
    // 只数「赋值调用」，注释里提到这个名字不算（详情组件的注释专门解释了为什么不能调）
    const calls = SOURCE.match(/=\s*useTasksData\(\)/g) ?? []
    expect(calls).toHaveLength(1)
  })

  it('详情组件的 actions 来自 props 而不是自己再取一份', () => {
    // TaskDetail 的签名里必须能拿到 actions
    expect(SOURCE).toMatch(/function TaskDetail\(\{[^}]*actions[^}]*\}: DetailProps\)/)
    expect(SOURCE).toMatch(/interface DetailProps[\s\S]*?actions: TasksActions/)
  })
})

/**
 * 完成被拒的行内反馈（v0.24）。
 *
 * 这条 bug 的本质是「失败只有 console.error，界面上零反馈」，而这一块全是 UI 状态机，
 * 没有可测的纯逻辑。结构断言是唯一可行的验证方式（04 §4① v0.24 也这么要求的）——
 * 只要有人把某个失败分支的 setNotice 删掉、或者把红字做成全局一条，这里就会红。
 */
describe('完成被拒的行内红字（v0.24）', () => {
  it('submitAndComplete 的三个失败分支都写入 notice，而不是只打控制台', () => {
    // v0.38：计分路径只剩一步 transition(pending_review)，失败要落红字；
    // 不计分直通仍是两步（transition + complete），两个分支各有一条
    const notices = SUBMIT_SOURCE.match(/setNotice\(/g) ?? []
    expect(notices).toHaveLength(3)
    expect(SUBMIT_SOURCE).toMatch(
      /if \(!res\.ok\)[\s\S]{0,200}?setNotice\(\{ taskId: task\.id, message: res\.error\.message \}\)/
    )
    expect(SUBMIT_SOURCE).toMatch(
      /if \(!done\.ok\)[\s\S]{0,300}?setNotice\(\{ taskId: task\.id, message: done\.error\.message \}\)/
    )
  })

  it('点完成只进 pending_review，不再在这里送审（v0.38 §5）', () => {
    expect(SUBMIT_SOURCE).toContain("to: 'pending_review'")
    // 送审与分流在 reviewFlow，useTasksData 不该再调用 runReview
    expect(USE_TASKS_SOURCE).not.toMatch(/runReview\(/)
  })

  it('文案零新增：显示的是 AppError.message 原样，代码里不写死中文句子', () => {
    expect(SUBMIT_SOURCE).not.toMatch(/message:\s*['"`]/)
    // console.error 保留（失败原因仍要进控制台），但必须同时有 setNotice
    expect(SUBMIT_SOURCE).toMatch(/console\.error\('\[tasks\] task\.complete/)
  })

  it('计时器有清理：notice 的 effect 返回清理函数，且新失败先清旧的', () => {
    expect(USE_TASKS_SOURCE).toContain('clearTimeout')
    expect(USE_TASKS_SOURCE).toMatch(/\}, \[notice\]\)/)
    const noticeEffect = USE_TASKS_SOURCE.slice(USE_TASKS_SOURCE.indexOf('notice === null'))
    // 清理函数里要 clearTimeout（卸载/重跑都不留计时器）
    expect(noticeEffect).toMatch(/return \(\) => \{[\s\S]*?clearTimeout/)
  })

  it('行内渲染：按 notice.taskId 匹配到具体那一行，不是全局一条', () => {
    expect(SOURCE).toContain('task-notice')
    expect(SOURCE).toContain('notice.taskId === task.id')
    expect(SOURCE).toContain('{notice.message}')
  })
})

/**
 * 今日已完成保留并变淡（v0.27 用户裁决）。
 * 行为全在纯模型（tasksModel.test.ts 已测），这里锁渲染结构：变淡类、disabled、右列留空。
 */
describe('今日已完成行（v0.27）', () => {
  const CSS = readFileSync(
    resolve(process.cwd(), 'src/renderer/main/features/tasks/tasks.css'),
    'utf8'
  )

  it('完成态类是整行 opacity .5（全站唯一的弱化表达），不搞删除线/文字', () => {
    expect(CSS).toMatch(/\.task-row--done\s*\{[^}]*opacity:\s*0\.5;/)
  })

  it('每日 done 行的勾选框真的 disabled 且呈已勾状态', () => {
    expect(SOURCE).toContain('task-check--on')
    expect(SOURCE).toContain('disabled={done}')
    expect(SOURCE).toMatch(/const done = occurrence\.status === 'done'/)
  })

  it('限时/活动 done 行：右列留空、详情无 [完成] 入口（v0.34 missed 同档、v0.38 起 pending_review 也没有）、v0.65 右列交给 TaskRight', () => {
    // v0.59：右列改成「剩余 · 目标」一行，done / missed 的留空判定收进纯模型 taskRightLabel
    // （模型侧另有 tasksModel.test 的用例覆盖）；v0.65 起右列渲染交给 TaskRight 组件
    expect(SOURCE).toMatch(/<span className="task-remaining">/)
    expect(SOURCE).toMatch(/<TaskRight\b/)
    expect(SOURCE).toMatch(
      /task\.type !== 'daily' &&[\s\S]{0,120}?task\.status !== 'done'[\s\S]{0,120}?task\.status !== 'missed'[\s\S]{0,120}?task\.status !== 'pending_review' \? \(/
    )
  })
})
