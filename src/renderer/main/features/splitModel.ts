/**
 * 右栏上下两半的比例模型（04 §4① v0.29）：纯逻辑文件。
 * 07 硬约束 1：本文件被 tests 直接 import，而 tsconfig.test.json 没有 DOM lib——
 * 禁止 import 任何碰 window 的模块，localStorage 的读写放组件层（index.tsx），这里只做数值与序列化。
 */

/** 默认下半份额：等价 v0.28 默认窗的观感（上 241 / 下 588，588/829 ≈ 0.71） */
export const DEFAULT_SPLIT = 0.71

/** 拖动下限：上半 ≥ 160px、下半 ≥ 360px（日历 240 + 积分区最少可见 120），到限夹住不回弹 */
export const MIN_TOP_PX = 160
export const MIN_BOTTOM_PX = 360

/** 比例持久化键（渲染层 localStorage，不动 AppSettings——02 §3.0 封闭接口） */
export const SPLIT_STORAGE_KEY = 'taskloop.rightSplit'

/** 容器几何信息（getBoundingClientRect 的最小投影，避免测试环境依赖 DOMRect）。
 * 语义 = flex 的「分配空间」：两半 + 两者之间的分割带要扣掉（组件层传入前扣除），
 * 这样夹限像素与 flexGrow 分配完全同口径。 */
export interface SplitRect {
  top: number
  height: number
}

/**
 * 下半像素夹限：低于下限抬到下限、高于上限压回上限。
 * 容器比「上、下限之和」还矮时，以上半的 160px 下限优先（maxBottom 更小者赢）。
 */
export function clampBottomPx(bottomPx: number, containerHeight: number): number {
  const maxBottom = Math.max(containerHeight - MIN_TOP_PX, 0)
  const minBottom = Math.min(MIN_BOTTOM_PX, maxBottom)
  return Math.min(Math.max(bottomPx, minBottom), maxBottom)
}

/** 指针 y → 下半像素 → 夹限 → 除以容器高得 r（下半份额，0~1 小数） */
export function ratioFromY(y: number, rect: SplitRect): number {
  if (rect.height <= 0) return DEFAULT_SPLIT
  const bottomPx = clampBottomPx(rect.top + rect.height - y, rect.height)
  return bottomPx / rect.height
}

/** 存储值 → r：非法 / 越界（非有限数、≤0、≥1）一律回落默认 */
export function parseSplit(raw: string | null): number {
  if (raw === null) return DEFAULT_SPLIT
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return DEFAULT_SPLIT
  return n
}

/** r → 存储值（十进制字符串） */
export function serializeSplit(ratio: number): string {
  return String(ratio)
}
