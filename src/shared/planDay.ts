/**
 * 计划日的判定（91 §2.2）。
 *
 * `plannedDay` 是「打算哪天做」，`dueAt` 是「最晚哪天交」——两者**完全独立**：
 * 计划日可以早于截止日、晚于截止日，也可以根本不存在（`null`）。
 * 把这两件事塞进 `dueAt` 一个字段，就表达不出「这件事我下周三做，但月底才交」。
 *
 * 零依赖：不引 react / electron / db，也不读客户端时钟——`today` 一律由调用方显式传入，
 * 渲染层与主进程（晨报）用同一份判定，口径不许分叉。
 */

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `YYYY-MM-DD` 且**是真实存在的日历日**。
 *
 * 正则只挡形状：`2026-02-30`、`2026-13-01` 都能过。所以再用 `Date.UTC` 构造后回读
 * 年 / 月 / 日，与原文不一致就判假（越界日期会被 Date 顺延到下个月，回读必然对不上）。
 */
export function isValidPlanDay(s: string): boolean {
  if (!DAY_SHAPE.test(s)) return false
  const [year, month, day] = s.split('-').map(Number)
  const at = new Date(Date.UTC(year, month - 1, day))
  return (
    at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
  )
}

/**
 * 这条任务今天该不该出现在活跃列表里。
 *
 * - `null` = 没有计划日 → 立刻可见（历史任务、手建的临时任务都是这种，行为与 v0.92 一致）
 * - `plannedDay <= today` → 可见。**昨天没做完的今天会继续出现**，这正是想要的：
 *   计划日是「打算哪天做」，不是「只在那天做」。
 *
 * 两边都是 `YYYY-MM-DD`，字符串字典序**就是**日期序，所以只做字符串比较：
 * 转成 `Date` 再比会引入时区，东八区 00:00–08:00 会整片串到前一天。
 * 这里**不做**任何「滚动到今天」「顺延搬运」——过期任务不搬家，它只是继续可见。
 */
export function visibleOn(plannedDay: string | null, today: string): boolean {
  return plannedDay === null || plannedDay <= today
}
