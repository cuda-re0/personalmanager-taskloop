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
