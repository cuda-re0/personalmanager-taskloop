import { randomUUID } from 'node:crypto'
import type { Alert } from '../../shared/types/domain'
import { nowIso } from '../db/localDay'
import * as alertRepo from '../db/repositories/alertRepo'

/**
 * 提醒确认链的业务层（v0.88）。
 *
 * 只做记录与状态翻转：**不 import `notifyWindow`**，投递仍留在 `reminderService`，
 * 层次不穿。两个超时常量是产品口径（normal 10 秒、strong 60 秒），不是配置项。
 */

export const ESCALATE_NORMAL_MS = 10_000
export const ESCALATE_STRONG_MS = 60_000

export interface AlertRecordInput {
  level: Alert['level']
  sourceId: string
  title: string
}

export function recordAlert(input: AlertRecordInput): Alert {
  return alertRepo.insert({
    id: randomUUID(),
    kind: 'reminder',
    level: input.level,
    sourceId: input.sourceId,
    title: input.title,
    firedAt: nowIso()
  })
}

/** 用户确认：没有匹配行返回 0，不抛错（重复点 / 已超时都不该让 UI 报错） */
export function ackAlert(sourceId: string): number {
  return alertRepo.ackBySourceId(sourceId, nowIso())
}

export function escalateDue(now: Date): number {
  const normalBefore = new Date(now.getTime() - ESCALATE_NORMAL_MS).toISOString()
  const strongBefore = new Date(now.getTime() - ESCALATE_STRONG_MS).toISOString()
  return alertRepo.escalateDue(normalBefore, strongBefore, now.toISOString())
}

export function listSince(sinceMs: number, now: Date): Alert[] {
  return alertRepo.listSince(new Date(now.getTime() - sinceMs).toISOString())
}
