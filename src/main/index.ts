import { app, BrowserWindow } from 'electron'
import {
  registerAttachmentProtocol,
  registerAttachmentScheme
} from './attachments/registerProtocol'
import { isAutoStart, seedAutoStart } from './autoStart'
import { initDb } from './db'
import { registerIpcHandlers } from './ipc'
import { clearExitTimers } from './ipc/registry'
import { startMcp, stopMcp } from './mcp'
import { startAlertScheduler } from './scheduler/alertScheduler'
import { startPulseScheduler } from './scheduler/pulseScheduler'
import { startReminderScheduler } from './scheduler/reminderScheduler'
import { startReviewSweeper } from './services/reviewSweeper'
import { ensureLhmStarted } from './services/sensorService'
import { startFxSweeper } from './services/fxSweeper'
import { runStartupUpdateCheck } from './update/updateService'
import { createHudWindow, createMainWindow, showMainWindow } from './windowManager'

/** 待提交超时扫描的停止函数（v0.38）：ready 后启动，退出前关掉 */
let stopReviewSweeper: (() => void) | null = null
/** 汇率周检查的停止函数（v0.45）：同上 */
let stopFxSweeper: (() => void) | null = null
/** 提醒调度器的停止函数（v0.58）：同上。窗口全关也要响，所以放主进程 */
let stopReminderScheduler: (() => void) | null = null
/** 高频周期提醒的停止函数（v0.86）：同上 */
let stopPulseScheduler: (() => void) | null = null
/** 提醒超时升级的停止函数（v0.88）：同上 */
let stopAlertScheduler: (() => void) | null = null
/** 启动期延时任务（v0.83 纳管）：退出时必须清，否则会在退出序列里继续跑 */
let startupUpdateTimer: ReturnType<typeof setTimeout> | null = null
let lhmTimer: ReturnType<typeof setTimeout> | null = null

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
    void startMcp() // 本机只读 MCP（77 单）：失败静默，不挡启动
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
    // 提醒调度（v0.58）：关掉主窗只留 HUD 时也要响，所以周期扫描在主进程
    stopReminderScheduler = startReminderScheduler()
    // 高频周期提醒（v0.86）：同一口径，扫描也在主进程
    stopPulseScheduler = startPulseScheduler()
    // 提醒超时升级（v0.88）：5 秒一轮，只标 escalated，不推送任何东西
    stopAlertScheduler = startAlertScheduler()

    // 启动自检更新（v0.60）：延时 8 秒，让窗口先起来、用户至少能看到界面；
    // 只在绿色版（isPackaged）里生效，开发模式直接返回；失败静默，不弹任何东西
    startupUpdateTimer = setTimeout(() => {
      void runStartupUpdateCheck()
    }, 8000)

    // 悬浮条温度（v0.62）：LHM 是管理员程序，拉起会弹 UAC；
    // 延后 3 秒，等窗口先画出来，避免开机自启时 UAC 抢在前台
    lhmTimer = setTimeout(() => {
      void ensureLhmStarted()
    }, 3000)

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
  stopReminderScheduler?.()
  stopReminderScheduler = null
  stopPulseScheduler?.()
  stopPulseScheduler = null
  stopAlertScheduler?.()
  stopAlertScheduler = null
  if (startupUpdateTimer !== null) {
    clearTimeout(startupUpdateTimer)
    startupUpdateTimer = null
  }
  if (lhmTimer !== null) {
    clearTimeout(lhmTimer)
    lhmTimer = null
  }
  clearExitTimers()
  void stopMcp()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
