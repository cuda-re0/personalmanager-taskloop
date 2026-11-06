import type { Message } from '@shared/types/domain'

/** 向前翻一页的结果：合并后的全量消息 + 是否还能继续往前翻 */
export interface OlderPage {
  messages: Message[]
  hasMore: boolean
}

/**
 * 把「更早的一页」并进现有列表（v0.89）。
 *
 * - 顺序：page 在前、existing 在后，页内保持原顺序；**不排序**——主进程返回的就是升序。
 * - 去重：只丢 existing 里 id 已出现在 page 中的那几条（游标重入 / 并发时会撞）。
 * - 不足一页 = 到底；正好一页当作「可能还有」，宁可多打一次空请求，不可漏历史。
 * - 纯函数：不改形参、不改元素对象，返回值一律是新数组。
 */
export function mergeOlderPage(
  existing: readonly Message[],
  page: readonly Message[],
  pageSize: number
): OlderPage {
  if (page.length === 0) return { messages: [...existing], hasMore: false }

  const pageIds = new Set(page.map(message => message.id))
  return {
    messages: [...page, ...existing.filter(message => !pageIds.has(message.id))],
    hasMore: page.length >= pageSize
  }
}
