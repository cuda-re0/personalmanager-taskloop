import { app, BrowserWindow } from 'electron'
import {
  registerAttachmentProtocol,
  registerAttachmentScheme
} from './attachments/registerProtocol'
import { isAutoStart, seedAutoStart } from './autoStart'
import { initDb } from './db'
import { registerIpcHandlers } from './ipc'
import { startReviewSweeper } from './services/reviewSweeper'
import { startFxSweeper } from './services/fxSweeper'
import { createHudWindow, createMainWindow, showMainWindow } from './windowManager'

/** 待提交超时扫描的停止函数（v0.38）：ready 后启动，退出前关掉 */
let stopReviewSweeper: (() => void) | null = null
/** 汇率周检查的停止函数（v0.45）：同上 */
let stopFxSweeper: (() => void) | null = null

/**
 * 单实例锁（v0.46）：必须在 `whenReady` 之前，且放在最前面。
 *
 * 拿不到锁说明已有一个实例在跑——本进程直接退出，不注册协议、不建库、不建窗、不注册 IPC。
 * 把主窗叫出来是第一个实例的事（见下方的事件监听）。
 */
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  // 必须在 app.whenReady() 之前（Electron 33）：晚了 secure/stream 标志不生效
  registerAttachmentScheme()

  // 再启动一次：不新建 HUD、不透传参数，只把已有主窗叫出来
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(() => {
    initDb() // W1 填实现
    console.log('[main] initDb() invoked')
    registerAttachmentProtocol() // 协议处理器要在 ready 之后挂
    // 首次运行写开机启动项（v0.46）：要 userData 路径，所以排在 initDb 之后
    seedAutoStart()
    // 开机自启只出悬浮条：主窗照建但不显示，等用户从悬浮条叫出来
    createMainWindow({ show: !isAutoStart(process.argv) })
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
}

app.on('before-quit', () => {
  stopReviewSweeper?.()
  stopReviewSweeper = null
  stopFxSweeper?.()
  stopFxSweeper = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
