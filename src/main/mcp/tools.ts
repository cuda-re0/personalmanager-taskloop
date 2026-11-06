import { compareTasks } from '../../renderer/main/features/tasks/tasksModel'
import { fmtRemaining } from '../../shared/format'
import { roundPoints } from '../../shared/points/rubric'
import type { Task, TaskStatus } from '../../shared/types/domain'
import { addDays, daysBetweenInclusive, isoWeekday, monthBounds, todayLocalDay } from '../db/localDay'
import * as occurrenceService from '../db/occurrenceService'
import * as alertService from '../services/alertService'
import * as messageService from '../services/messageService'
import * as pointsService from '../services/pointsService'
import * as taskService from '../services/taskService'

/**
 * 77 单 · 本机 MCP 的五个只读工具。
 *
 * 只查现有 service，不写库、不调 AI、不发通知。今日 occurrence 一律走
 * `listRangeRaw()`——`listToday()` 内部会 ensureRange 补齐缺口，那是写操作。
 */

const ALL_STATUSES: TaskStatus[] = [
  'todo',
  'doing',
  'pending_review',
  'reviewing',
  'done',
  'missed',
  'discarded',
  'archived'
]

type Scope = 'active' | 'today' | 'all'
type PointRange = 'today' | 'week' | 'month'

interface DayRange {
  from: string
  to: string
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: boolean
  }
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'get_overview',
    description: '今日概览：待办数、今日打卡数、今日/本周/本月积分',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_tasks',
    description: '任务列表（不含详情正文）',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['active', 'today', 'all'] },
        limit: { type: 'number', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_task',
    description: '任务详情（含正文与子步骤）',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'list_messages',
    description: '聊天文本消息',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_points',
    description: '积分流水汇总',
    inputSchema: {
      type: 'object',
      properties: { range: { type: 'string', enum: ['today', 'week', 'month'] } },
      additionalProperties: false
    }
  },
  {
    name: 'list_alerts',
    description: '列出最近提醒及其确认状态；acked=false 且 escalated=true 表示用户没理会',
    inputSchema: {
      type: 'object',
      properties: { sinceMinutes: { type: 'number', minimum: 1, maximum: 1440 } },
      additionalProperties: false
    }
  }
]

/** 带本地时区偏移的 ISO 时刻（项目里的 nowIso() 是 UTC 'Z' 形态，这里按 77 单要求补偏移） */
function localIsoNow(): string {
  const now = new Date()
  const offsetMin = -now.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  const wall = new Date(now.getTime() + offsetMin * 60000).toISOString()
  return `${wall.slice(0, -1)}${sign}${hh}:${mm}`
}

function limitOf(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(100, Math.max(1, Math.floor(raw)))
}

function scopeOf(raw: unknown): Scope {
  if (raw === undefined || raw === 'active') return 'active'
  if (raw === 'today' || raw === 'all') return raw
  throw new Error('scope 只能是 active、today 或 all')
}

function rangeArgOf(raw: unknown): PointRange {
  if (raw === undefined || raw === 'today') return 'today'
  if (raw === 'week' || raw === 'month') return raw
  throw new Error('range 只能是 today、week 或 month')
}

function requireId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('任务 id 不能为空')
  return raw
}

/** 周 = 本周一至今天，月 = 本月 1 号至今天，都是本地日历日闭区间 */
function rangeOf(kind: PointRange): DayRange {
  const today = todayLocalDay()
  if (kind === 'today') return { from: today, to: today }
  if (kind === 'week') return { from: addDays(today, 1 - isoWeekday(today)), to: today }
  const [year, month] = today.split('-').map(Number)
  return { from: monthBounds(year, month).from, to: today }
}

/** 口径复用 pointsService.dayStatOf，不在工具里重写算分 */
function pointsInRange(range: DayRange): number {
  const total = daysBetweenInclusive(range.from, range.to).reduce(
    (sum, day) => sum + pointsService.dayStatOf(day).points,
    0
  )
  return roundPoints(total)
}

function stepsByParent(): Map<string, { done: number; total: number }> {
  const all = taskService.listTasks({ status: ALL_STATUSES, includeSubtasks: true })
  const map = new Map<string, { done: number; total: number }>()
  for (const task of all) {
    if (task.parentId === null) continue
    const stat = map.get(task.parentId) ?? { done: 0, total: 0 }
    stat.total += 1
    if (task.status === 'done') stat.done += 1
    map.set(task.parentId, stat)
  }
  return map
}

function getOverview(): Record<string, unknown> {
  const today = todayLocalDay()
  const pendingTasks = taskService
    .listTasks({ status: ALL_STATUSES })
    .filter(
      task =>
        task.status !== 'done' &&
        task.status !== 'missed' &&
        task.status !== 'discarded' &&
        task.status !== 'archived'
    ).length
  return {
    now: localIsoNow(),
    today,
    pendingTasks,
    todayOccurrences: occurrenceService.listRangeRaw(today, today).length,
    points: {
      today: pointsInRange(rangeOf('today')),
      week: pointsInRange(rangeOf('week')),
      month: pointsInRange(rangeOf('month'))
    }
  }
}

function listTasksTool(args: Record<string, unknown>): Record<string, unknown> {
  const scope = scopeOf(args.scope)
  const limit = limitOf(args.limit, 50)
  const all = taskService.listTasks({ status: ALL_STATUSES })

  let picked: Task[]
  if (scope === 'today') {
    const ids = new Set(
      occurrenceService.listRangeRaw(todayLocalDay(), todayLocalDay()).map(o => o.taskId)
    )
    picked = all.filter(task => ids.has(task.id))
  } else if (scope === 'all') {
    picked = all
  } else {
    // 默认「在办」口径：已删（discarded）/ 已归档（archived）不算在办（v0.85c）
    picked = all.filter(
      task =>
        task.status !== 'done' &&
        task.status !== 'missed' &&
        task.status !== 'discarded' &&
        task.status !== 'archived'
    )
  }

  const steps = stepsByParent()
  const now = new Date()
  const tasks = picked.sort(compareTasks).slice(0, limit).map(task => ({
    id: task.id,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt,
    parentId: task.parentId,
    remaining: fmtRemaining(task.dueAt, task.type, now),
    steps: steps.get(task.id) ?? { done: 0, total: 0 }
  }))
  return { scope, limit, tasks }
}

function getTaskTool(args: Record<string, unknown>): Record<string, unknown> {
  const { subtasks, ...task } = taskService.getTaskWithSubtasks(requireId(args.id))
  return {
    ...task,
    subtasks: subtasks.map(step => ({ id: step.id, title: step.title, status: step.status })),
    requiresEvidence: task.requiresEvidence
  }
}

function listMessagesTool(args: Record<string, unknown>): Record<string, unknown> {
  const limit = limitOf(args.limit, 30)
  const since = typeof args.since === 'string' && args.since.trim() !== '' ? args.since : null
  const messages = since
    ? messageService.textMessagesAfter(since, limit)
    : messageService.recentChatMessages(limit)
  return {
    messages: messages.map(message => ({
      id: message.id,
      role: message.role,
      text: message.contentMd,
      mode: message.mode,
      createdAt: message.createdAt,
      attachments: message.attachments.length
    }))
  }
}

function getPointsTool(args: Record<string, unknown>): Record<string, unknown> {
  const range = rangeArgOf(args.range)
  const bounds = rangeOf(range)
  const entries = pointsService.listLedger({ from: bounds.from, to: bounds.to, limit: 100 })
  return {
    range,
    total: pointsInRange(bounds),
    items: entries
      .slice()
      .reverse()
      .map(entry => ({
        at: entry.createdAt,
        delta: entry.delta,
        reason: entry.reasonText,
        taskId: entry.taskId
      }))
  }
}

/** `sinceMinutes` 越界夹到 1..1440、非数字按默认 60——工具不因为参数离谱而抛错 */
function sinceMinutesOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 60
  return Math.min(1440, Math.max(1, Math.floor(raw)))
}

function listAlertsTool(args: Record<string, unknown>): Record<string, unknown> {
  const sinceMinutes = sinceMinutesOf(args.sinceMinutes)
  const now = new Date()
  // listSince 是升序：超过 100 条时留尾部（最近的），仍是升序输出
  const alerts = alertService.listSince(sinceMinutes * 60_000, now).slice(-100)
  return {
    now: localIsoNow(),
    alerts: alerts.map(alert => ({
      id: alert.id,
      kind: alert.kind,
      level: alert.level,
      sourceId: alert.sourceId,
      title: alert.title,
      firedAt: alert.firedAt,
      acked: alert.ackedAt !== null,
      escalated: alert.escalatedAt !== null,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(alert.firedAt)) / 1000))
    }))
  }
}

export function callTool(
  name: string,
  args: Record<string, unknown> = {}
): Record<string, unknown> {
  switch (name) {
    case 'get_overview':
      return getOverview()
    case 'list_tasks':
      return listTasksTool(args)
    case 'get_task':
      return getTaskTool(args)
    case 'list_messages':
      return listMessagesTool(args)
    case 'get_points':
      return getPointsTool(args)
    case 'list_alerts':
      return listAlertsTool(args)
    default:
      throw new Error(`未知工具：${name}`)
  }
}
