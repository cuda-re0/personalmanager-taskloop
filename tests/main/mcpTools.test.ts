import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callTool } from '../../src/main/mcp/tools'
import * as messageService from '../../src/main/services/messageService'
import * as taskService from '../../src/main/services/taskService'
import { closeTestDb, openMemoryDb } from '../db/helpers'

beforeEach(() => {
  openMemoryDb()
})

afterEach(() => {
  closeTestDb()
})

describe('本机 MCP 只读工具（77 单 C2）', () => {
  it('list_tasks 返回造出来的任务，字段齐全且不含 detailMd', () => {
    taskService.createTask({
      type: 'deadline',
      title: '写季度报告',
      detailMd: '这份正文不该出现在列表里'
    })

    const result = callTool('list_tasks') as { tasks: Record<string, unknown>[] }
    expect(result.tasks).toHaveLength(1)
    const item = result.tasks[0]
    expect(item.title).toBe('写季度报告')
    for (const key of [
      'id',
      'title',
      'type',
      'status',
      'priority',
      'dueAt',
      'parentId',
      'remaining',
      'steps'
    ]) {
      expect(Object.prototype.hasOwnProperty.call(item, key)).toBe(true)
    }
    expect(Object.prototype.hasOwnProperty.call(item, 'detailMd')).toBe(false)
  })

  it('get_task 对不存在的 id 抛错', () => {
    expect(() => callTool('get_task', { id: 'not-exist' })).toThrow()
  })

  it('list_messages 的 since 只返回更晚的消息', () => {
    messageService.appendMessage({
      role: 'user',
      kind: 'text',
      contentMd: '一',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    const second = messageService.appendMessage({
      role: 'assistant',
      kind: 'text',
      contentMd: '二',
      createdAt: '2026-01-01T00:00:01.000Z'
    })
    messageService.appendMessage({
      role: 'user',
      kind: 'text',
      contentMd: '三',
      createdAt: '2026-01-01T00:00:02.000Z'
    })

    const result = callTool('list_messages', { since: second.id }) as {
      messages: { text: string }[]
    }
    expect(result.messages.map(message => message.text)).toEqual(['三'])
  })
})

describe('已删任务不进 MCP 在办口径（v0.85c）', () => {
  it('list_tasks 与 pendingTasks 都不含 discarded 任务', () => {
    const dead = taskService.createTask({ type: 'deadline', title: '要删的' })
    taskService.removeTask(dead.id)
    const alive = taskService.createTask({ type: 'deadline', title: '活着的' })

    const list = callTool('list_tasks') as { tasks: { id: string }[] }
    expect(list.tasks.map(task => task.id)).toEqual([alive.id])

    const overview = callTool('get_overview') as { pendingTasks: number }
    expect(overview.pendingTasks).toBe(1)
  })
})
