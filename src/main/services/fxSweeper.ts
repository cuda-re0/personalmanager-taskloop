import { ensureWeek } from './fxService'

/**
 * 汇率周检查（v0.45，45 §5.2）。
 *
 * 每周一自动评估一次——这个"自动"必须由主进程保证：窗口可以一整天不开，
 * 但汇率该换还是得换。所以启动立即跑一次（补上关机期间跨过的周一），之后每 30 分钟看一次
 * 「本周有没有记录」，有就什么都不做（`ensureWeek` 幂等）。
 *
 * 边界与 `reviewSweeper` 一致：单轮异常只 `console.warn`，不许掀掉主进程；
 * 失败也已经落了一行 fallback，所以下一轮不会重复烧 token。
 */

/** 检查周期：30 分钟。低于这个数没有意义（一期只写一条，幂等靠查库） */
export const FX_SWEEP_INTERVAL_MS = 30 * 60 * 1000

/**
 * 启动检查：立即一次 + 每 30 分钟一次。返回 `stop()`，由 `app.before-quit` 调用。
 */
export function startFxSweeper(): () => void {
  const run = (): void => {
    void ensureWeek().catch((e: unknown) => {
      // 库还没就绪 / 被关闭：不让它掀掉主进程
      console.warn('[fx] sweeper 本轮失败', e)
    })
  }
  run()
  const timer = setInterval(run, FX_SWEEP_INTERVAL_MS)
  return () => clearInterval(timer)
}
