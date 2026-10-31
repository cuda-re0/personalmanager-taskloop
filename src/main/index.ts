import { app, BrowserWindow } from 'electron'
import {
  registerAttachmentProtocol,
  registerAttachmentScheme
} from './attachments/registerProtocol'
import { initDb } from './db'
import { registerIpcHandlers } from './ipc'
import { startReviewSweeper } from './services/reviewSweeper'
import { startFxSweeper } from './services/fxSweeper'
import { createHudWindow, createMainWindow } from './windowManager'

// 必须在 app.whenReady() 之前（Electron 33）：晚了 secure/stream 标志不生效
registerAttachmentScheme()

/** 待提交超时扫描的停止函数（v0.38）：ready 后启动，退出前关掉 */
let stopReviewSweeper: (() => void) | null = null
/** 汇率周检查的停止函数（v0.45）：同上 */
let stopFxSweeper: (() => void) | null = null

app.whenReady().then(() => {
  initDb() // W1 填实现
  console.log('[main] initDb() invoked')
  registerAttachmentProtocol() // 协议处理器要在 ready 之后挂
  createMainWindow()
  createHudWindow()
  registerIpcHandlers() // W2 填实现
  console.log('[main] registerIpcHandlers() invoked')
  // 待提交任务 10 分钟未提交自动退回 doing：窗口关着也要生效，所以放主进程
  stopReviewSweeper = startReviewSweeper()
  // 每周一换一次汇率：启动先补一次（可能跨了周一），之后 30 分钟看一次（幂等）
  stopFxSweeper = startFxSweeper()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('before-quit', () => {
  stopReviewSweeper?.()
  stopReviewSweeper = null
  stopFxSweeper?.()
  stopFxSweeper = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
