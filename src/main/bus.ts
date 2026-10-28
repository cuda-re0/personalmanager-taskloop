import { BrowserWindow } from 'electron'
import { CH } from '@shared/channels'
import type { DomainEvent } from '@shared/types/events'

/**
 * 主进程 → 渲染进程的单向事件总线（05 W2 段交付项 1）。
 *
 * 传输层可注入：`npm test` 用 ELECTRON_RUN_AS_NODE 起 Electron 内置 node，
 * 没有 BrowserWindow，所以测试先 `setTransport(fn)` 收集事件；
 * 不注入时走默认实现——枚举 `BrowserWindow.getAllWindows()` 逐个 send。
 */

export type Transport = (event: DomainEvent) => void

let transport: Transport | null = null

/** 测试注入收集函数用；传 null 恢复默认实现 */
export function setTransport(fn: Transport | null): void {
  transport = fn
}

function defaultTransport(event: DomainEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // 关掉 HUD 之后再广播不能崩：先判存活，再让每个 send 独立兜底
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(CH.bus.event, event)
    } catch (e) {
      console.error(`[bus] 向窗口发送 ${event.type} 失败`, e)
    }
  }
}

export function broadcast(event: DomainEvent): void {
  const fn = transport ?? defaultTransport
  fn(event)
}
