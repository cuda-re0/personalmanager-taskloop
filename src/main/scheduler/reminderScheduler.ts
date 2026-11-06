import type { Reminder } from '../../shared/types/domain'
import { nowIso } from '../db/localDay'
import * as reminderRepo from '../db/repositories/reminderRepo'
import { STALE_POPUP_MS } from '../services/reminderPlan'
import { ensureRepeatHorizon, fireDue, fireOne, purgeInactiveTaskReminders, syncAll } from '../services/reminderService'

/**
 * 提醒调度器（v0.58，58 §3.3）。
 *
 * 每 30 秒扫一次到点的 `reminders` 行。**不用**「setTimeout 到最近一条 + 心跳」的双机制：
 * 30 秒误差对「提前 1 小时」完全够用，而且休眠唤醒后下一次 tick 自然对齐，
 * 不必维护一个可能被系统挂起而长期不响的定时器。
 *
 * 启动时先跑一次「补发判定」：关机期间错过的提醒不许开机弹一堆——
 * 只有 10 分钟内到点的那一条补弹一次，更早的一律标成已触发（不弹，也不写消息）。
 */

/** 扫描周期：30 秒 */
export const REMINDER_TICK_MS = 30_000

/**
 * 启动补发判定：把错过的提醒消化掉，最多补弹最近的一条。
 *
 * `listDue` 按 `fire_at` 升序，所以"最近的一条"是数组里最后一个落在窗口内的。
 * 其余（窗口内更早的 + 窗口外的全部）只标已触发、渠道留空：状态收干净、不弹窗——
 * 否则开机瞬间会连着弹好几张横幅。
 */
function catchUpMissed(now: Date): void {
  const due = reminderRepo.listDue(now.toISOString())
  if (due.length === 0) return

  const nowMs = now.getTime()
  const inWindow = due.filter(reminder => {
    const at = Date.parse(reminder.fireAt)
    return !Number.isNaN(at) && nowMs - at <= STALE_POPUP_MS
  })
  const latest: Reminder | null = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null

  for (const reminder of due) {
    if (latest !== null && reminder.id === latest.id) continue
    try {
      // 渠道留空：这不是"发过"，只是"过期了"。消息也不写（58 §3.3 的写死口径）。
      reminderRepo.markFired(reminder.id, [], nowIso())
    } catch (e: unknown) {
      console.warn('[reminder] 错过的一条没能收口', reminder.id, e)
    }
  }

  if (latest === null) return
  try {
    fireOne(latest)
  } catch (e: unknown) {
    console.warn('[reminder] 补发失败', latest.id, e)
  }
}

/**
 * 启动提醒扫描：先做一次补发判定，之后每 30 秒扫一次。返回 `stop()`，由 `app.before-quit` 调用。
 *
 * 单轮异常只 `console.warn`：库还没就绪 / 被关闭都不许掀掉主进程（与两个 sweeper 同一口径）。
 */
export function startReminderScheduler(): () => void {
  const run = (): void => {
    try {
      // 顺序不许反：先补建再扫描，否则新建重复任务的第一条要等下一轮 30 秒（81 §4.2）
      ensureRepeatHorizon(new Date())
      fireDue(new Date())
    } catch (e: unknown) {
      console.warn('[reminder] 本轮扫描失败', e)
    }
  }

  try {
    // 清场必须在 catchUpMissed 之前：补发会把过去到点的 active 行收成"已触发"甚至真的弹一次，
    // 排在后面等于先给已删任务发提醒、再删行（v0.85b）。单独包一层，失败不许影响后面三步。
    try {
      purgeInactiveTaskReminders()
    } catch (e: unknown) {
      console.warn('[reminder] 已删任务的提醒清场失败', e)
    }
    // 顺序不能反：先消化错过的（它们此刻可能还是 active 行），再整体重建。
    // 反过来重建会先把这些行删掉——`planReminders` 只留未来的，过去的一律不留，
    // 于是补发判定什么都看不到，关机期间错过的提醒就彻底消失了。
    catchUpMissed(new Date())
    // 老任务（本版之前建的，只有偏移没有 reminders 行）在这里补建，不必等用户去编辑一次
    syncAll()
    ensureRepeatHorizon(new Date())
  } catch (e: unknown) {
    console.warn('[reminder] 启动补发判定失败', e)
  }

  const timer = setInterval(run, REMINDER_TICK_MS)
  return () => clearInterval(timer)
}
