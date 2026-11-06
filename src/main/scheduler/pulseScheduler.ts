import type { Pulse } from '../../shared/types/domain'
import { nowIso } from '../db/localDay'
import * as pulseRepo from '../db/repositories/pulseRepo'
import { showNotice } from '../notify/notifyWindow'
import { isDue } from '../services/pulseService'

/**
 * 高频周期提醒的扫描器（v0.86）。
 *
 * 每 20 秒扫一次启用的 pulses，只看「当下是否到期」，**没有任何补发逻辑**：
 * 关机 / 休眠期间错过的次数一律不弹。启动时先把所有启用项的 last_fired_at 重置到当下，
 * 否则重启后第一个 tick 会看到一堆 last_fired_at 早就过期的行，一次弹一串。
 */

export const PULSE_TICK_MS = 20_000

function firePulse(pulse: Pulse, now: Date): void {
  // 顺序不许反：写成功才算触发，抛错就整条跳过，下一轮再试
  pulseRepo.markFired(pulse.id, now.toISOString())
  // 三个空串是刻意的：轻形态对 remainLabel === '' 直接不渲染副行，只显示标题
  showNotice({
    level: 'normal',
    title: pulse.title,
    remainLabel: '',
    typeLabel: '',
    dueLabel: '',
    reminderId: pulse.id
  })
}

export function startPulseScheduler(): () => void {
  const run = (): void => {
    try {
      const now = new Date()
      for (const pulse of pulseRepo.listEnabled()) {
        if (isDue(pulse, now)) firePulse(pulse, now)
      }
    } catch (e: unknown) {
      console.warn('[pulse] 本轮扫描失败', e)
    }
  }

  // 必须在 setInterval 之前：这一步是「启动不补发」的唯一保证
  try {
    pulseRepo.resetLastFired(nowIso())
  } catch (e: unknown) {
    console.warn('[pulse] 启动重置失败', e)
  }

  const timer = setInterval(run, PULSE_TICK_MS)
  return () => clearInterval(timer)
}
