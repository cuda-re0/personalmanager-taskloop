/**
 * 逐字显现的**纯逻辑**（04 §3.4.2 v0.43，v0.37 引入）。
 *
 * 主进程一次拿到完整回复、一次 `message.patch` 落库；这里只负责"按时间算出该显示到第几个字"。
 * 不做逐字 `setTimeout`：一个 500 字的回复会排出 500 个计时器，切会话时全都要清，
 * 而且 `setTimeout` 的最小精度（≈4ms）会让 40 字/秒变成 33 字/秒。
 *
 * 也不持有计时器：`tick(nowMs)` 由调用方（`requestAnimationFrame`）驱动。
 * 这样测试可以注入 `now` 与任意 `nowMs`，不依赖真实时间。
 */

/** 基准速率：40 字/秒（04 §3.4.2） */
export const TYPE_BASE_CPS = 40
/** 长回复提速档：80 字/秒 */
export const TYPE_FAST_CPS = 80
/** 超过这个长度切到提速档（4.3 节：本条总长 > 400 字） */
export const TYPE_FAST_THRESHOLD = 400

export interface TyperOptions {
  text: string
  /** 每帧最多推一次（由 `tick` 保证），入参是"到此刻该显示的前缀" */
  onUpdate: (partial: string) => void
  /** 起始时刻来源，默认 `Date.now`；调用方要传与 `tick(nowMs)` 同一个钟 */
  now?: () => number
}

export interface Typer {
  /** 推进到 `nowMs`；到末尾会自动停在末尾，重复调用不越界 */
  tick(nowMs: number): void
  /** 立即全显并结束（例如组件卸载前要落一个终态） */
  finish(): void
  /** 停止推进，不再推 `onUpdate` */
  stop(): void
  /** 是否已经结束（调用方据此清掉自己那份引用 / 取消 rAF） */
  done(): boolean
  /** 目标文本的字符数（按码点，不按 UTF-16 单元） */
  total(): number
}

/**
 * `createTyper`：按已过时间算应显示的字符数，`tick` 之间不做任何计时。
 *
 * 字符按**码点**切（`Array.from`）：`.slice` 会把 emoji 的代理对切成半个字符，
 * 渲染层拿到半个码点会显示成方块，而且下一次追加也修不回来。
 */
export function createTyper(options: TyperOptions): Typer {
  const chars = Array.from(options.text)
  const total = chars.length
  const rate = total > TYPE_FAST_THRESHOLD ? TYPE_FAST_CPS : TYPE_BASE_CPS
  const clock = options.now ?? Date.now
  const startedAt = clock()

  let shown = 0
  let finished = false

  const push = (count: number): void => {
    if (count <= shown) return
    shown = count
    options.onUpdate(count >= total ? options.text : chars.slice(0, count).join(''))
  }

  return {
    tick(nowMs: number): void {
      if (finished || total === 0) {
        if (!finished && total === 0) finished = true
        return
      }
      const elapsedMs = Math.max(0, nowMs - startedAt)
      const target = Math.min(total, Math.floor((elapsedMs / 1000) * rate))
      push(target)
      if (shown >= total) finished = true
    },
    finish(): void {
      if (finished && shown >= total) return
      finished = true
      shown = total
      options.onUpdate(options.text)
    },
    stop(): void {
      finished = true
    },
    done(): boolean {
      return finished
    },
    total(): number {
      return total
    }
  }
}
