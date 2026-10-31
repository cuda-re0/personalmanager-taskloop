import { roundPoints } from './points/rubric'

/**
 * 分值显示（04 §4③）：最多 2 位小数、去掉尾零。
 *
 * 23 → '23'；10.75 → '10.75'；5.5 → '5.5'；-10.75 → '-10.75'。
 * 精度收敛只发生在 roundPoints 里，本文件不做别的取整与定点格式化。
 */
export function fmtPoints(v: number): string {
  return String(roundPoints(v))
}

/**
 * 金额显示（45 §7.1）：分 → 元，整数不带小数点、有小数保留两位，**去尾零**。
 *
 * 1200 → '12'；1250 → '12.5'；1205 → '12.05'。
 *
 * 全程整数运算（先整除百位、余数当"分"再拼字符串）：金额一旦经过浮点，
 * `12.5 * 100 = 1250.0000000000002` 这类误差会顺着"已花 / 500"一路漂到界面上。
 * 本文件与 `fmtPoints` 共享同一条纪律：不做任何取整或定点格式化调用。
 * 负数由调用方负责加符号（这里只画金额本身）。
 */
export function fmtMoney(cents: number): string {
  const total = cents < 0 ? -Math.trunc(cents) : Math.trunc(cents)
  const yuan = (total - (total % 100)) / 100
  const fen = total % 100
  if (fen === 0) return String(yuan)
  if (fen % 10 === 0) return `${yuan}.${fen / 10}`
  return `${yuan}.${String(fen).padStart(2, '0')}`
}
