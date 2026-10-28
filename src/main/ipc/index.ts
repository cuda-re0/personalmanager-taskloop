import { ipcMain } from 'electron'
import { createHandlers } from './registry'

/**
 * IPC 注册入口。
 * W0 只留接线点：`src/main/index.ts` 已调用 `registerIpcHandlers()`，这里把
 * `ipcMain` 注入 `createHandlers`——通道名一律取自 `@shared/channels`，实现与
 * 测试解耦的部分在 `registry.ts`（测试传假 ipc 跑整张表）。
 */
export function registerIpcHandlers(): void {
  createHandlers(ipcMain)
}
