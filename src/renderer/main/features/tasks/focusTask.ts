/**
 * `taskloop:focus-task` 的收口（v0.16 的 W6B → W6 交接点）。
 *
 * 生产方：日历浮层点行（W6B）、④ 明细点条目（W6）；
 * 消费方：右栏 ① —— 展开该任务、滚动到可视区、短暂高亮。
 *
 * 走 `window` CustomEvent 而不是加一条 IPC 通道：这是纯渲染层的跨区块联动，
 * 不涉及主进程状态，也不该为它扩一条已冻结的通道表。
 */
export const FOCUS_TASK_EVENT = 'taskloop:focus-task'

interface FocusTaskDetail {
  id: string
}

export function emitFocusTask(id: string): void {
  window.dispatchEvent(new CustomEvent<FocusTaskDetail>(FOCUS_TASK_EVENT, { detail: { id } }))
}

export function onFocusTask(cb: (id: string) => void): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<FocusTaskDetail>).detail
    if (detail && typeof detail.id === 'string' && detail.id !== '') cb(detail.id)
  }
  window.addEventListener(FOCUS_TASK_EVENT, listener)
  return () => window.removeEventListener(FOCUS_TASK_EVENT, listener)
}
