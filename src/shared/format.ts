import { roundPoints } from './points/rubric'

/**
 * 分值显示（04 §4③）：最多 2 位小数、去掉尾零。
 *
 * 23 → '23'；10.75 → '10.75'；5.5 → '5.5'；-10.75 → '-10.75'。
 * 精度收敛只发生在 roundPoints 里，本文件不出现 Math.round / toFixed。
 */
export function fmtPoints(v: number): string {
  return String(roundPoints(v))
}
