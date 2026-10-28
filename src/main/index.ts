import { app, BrowserWindow } from 'electron'
import {
  registerAttachmentProtocol,
  registerAttachmentScheme
} from './attachments/registerProtocol'
import { initDb } from './db'
import { registerIpcHandlers } from './ipc'
import { createHudWindow, createMainWindow } from './windowManager'

// 必须在 app.whenReady() 之前（Electron 33）：晚了 secure/stream 标志不生效
registerAttachmentScheme()

app.whenReady().then(() => {
  initDb() // W1 填实现
  console.log('[main] initDb() invoked')
  registerAttachmentProtocol() // 协议处理器要在 ready 之后挂
  createMainWindow()
  createHudWindow()
  registerIpcHandlers() // W2 填实现
  console.log('[main] registerIpcHandlers() invoked')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
