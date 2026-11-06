import * as alertService from '../services/alertService'

/**
 * 提醒超时升级的扫描器（v0.88）。
 *
 * 每 5 秒跑一次，只做一件事：把「弹过但没确认」的行按 level 标 escalated。
 * 不删旧行、不做 TTL、不补扫历史——alerts 只增，行数由记录量自然决定。
 */

export const ALERT_TICK_MS = 5_000

export function startAlertScheduler(): () => void {
  const run = (): void => {
    try {
      alertService.escalateDue(new Date())
    } catch (e: unknown) {
      console.warn('[alert] 本轮扫描失败', e)
    }
  }

  const timer = setInterval(run, ALERT_TICK_MS)
  return () => clearInterval(timer)
}
