/**
 * IPC 注册入口。
 * W0 只留接线点：`src/main/index.ts` 已调用 `registerIpcHandlers()`，W2 在这里
 * 注册 `ipcMain.handle`，通道名一律取自 `@shared/channels`。
 */
export function registerIpcHandlers(): void {
  // TODO(W2): 注册 ipcMain.handle / 事件总线转发
}
