import type { DayStat, FxRate } from '../../../shared/types/domain'
import { getDb } from '../connection'
import { DAY_STAT_COLUMNS, FX_RATE_COLUMNS, fxRateInsertParams, mapDayStat, mapFxRate } from '../mappers'
import type { DayStatRow, FxRateInsert, FxRateRow } from '../mappers'

/**
 * fx_rates 的数据访问层（v0.45）。
 *
 * 本层只读不判：汇率该是多少由 `fxService.ensureWeek` 决定，这里只负责
 * 「一期一条、按周取、取最近一条」。
 *
 * `weekSnapshot` 是唯一跨表读的地方（daily_stats + tasks）。它放这里而不是
 * statsRepo/taskRepo，是因为那两处不在 45 的白名单里——**不是**因为职责更合适。
 * `date(updated_at,'localtime')` 是 01 §4.1 明列的例外写法：`updated_at` 存 UTC ISO，
 * 与本地日直接比字符串会串天。
 */

const SELECT_FX = `SELECT ${FX_RATE_COLUMNS.join(', ')} FROM fx_rates`

/** 最近一期（按生效周倒序）。表空返回 null，由调用方决定默认汇率 */
export function latest(): FxRate | null {
  const row = getDb().prepare(`${SELECT_FX} ORDER BY week_start DESC LIMIT 1`).get() as
    | FxRateRow
    | undefined
  return row === undefined ? null : mapFxRate(row)
}

export function byWeek(weekStart: string): FxRate | null {
  const row = getDb().prepare(`${SELECT_FX} WHERE week_start = ?`).get(weekStart) as
    | FxRateRow
    | undefined
  return row === undefined ? null : mapFxRate(row)
}

/** 写入一期。`week_start` 唯一：重复插入会抛约束错，由调用方兜（并发下等同于"别人已经写了"） */
export function insert(row: FxRateInsert): void {
  getDb()
    .prepare(
      `INSERT INTO fx_rates (${FX_RATE_COLUMNS.join(', ')})
       VALUES (${FX_RATE_COLUMNS.map(() => '?').join(', ')})`
    )
    .run(...fxRateInsertParams(row))
}

export interface WeekSnapshot {
  /** 上周的日聚合（没有记录的日期不返回，缺失即 0） */
  days: DayStat[]
  /** 上周判失败的限时/活动任务数（status='missed' 是终点状态，按 updated_at 落周） */
  missedTasks: number
}

/**
 * 上周的「可看数据」：日聚合 + 判失败任务数。
 *
 * 三样合计为 0 时 `fxService` 不调 AI（不为一片空白烧 token）；这同一份数据也是
 * AI 评估的输入，所以只查一次。
 */
export function weekSnapshot(from: string, to: string): WeekSnapshot {
  const days = (
    getDb()
      .prepare(
        `SELECT ${DAY_STAT_COLUMNS.join(', ')} FROM daily_stats
         WHERE day >= ? AND day <= ? ORDER BY day ASC`
      )
      .all(from, to) as DayStatRow[]
  ).map(mapDayStat)

  const missed = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE status = 'missed' AND date(updated_at, 'localtime') >= ? AND date(updated_at, 'localtime') <= ?`
    )
    .get(from, to) as { n: number }

  return { days, missedTasks: missed.n }
}
