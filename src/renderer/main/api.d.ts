/**
 * preload 经 contextBridge 暴露的 `window.api`（02 §4）。
 * 渲染层所有 IPC 调用都走它，`Api` 的唯一来源是 src/shared/types/ipc.ts。
 */
import type { Api } from '@shared/types/ipc'

declare global {
  interface Window {
    api: Api
  }
}

export {}
