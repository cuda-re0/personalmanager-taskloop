import { BrowserWindow, screen } from 'electron'
import { CH } from '@shared/channels'
import type { NotifyPayload } from '@shared/types/ipc'
import { loadRenderer, webPreferences } from '../windowManager'

/**
 * 提醒窗口（v0.58，58 §3.4）。
 *
 * v0.63：本模块已从提醒调用链上摘下（`fireOne` 改为唤主窗，见 58c）。
 * 代码与测试保留，供将来"应用完全不在前台时才弹小条"的场景复用——**当前无调用方**。
 *
 * 两个形态、都是自建窗口，**不用 Windows 原生通知**（用户裁决）：
 * - 轻（`normal`）：屏高 1/8 处的顶部横幅，点任意位置即关；
 * - 重（`strong`）：屏幕正中 480×300 的小窗，只有 `×` 可点，`screen-saver` 层级盖得住全屏应用。
 *
 * 单例 + 队列：同一时刻只开一个窗口。第二条提醒来的时候只入队（最多 5 条，超出直接
 * 丢弃——消息已经写进会话区了，丢的只是"弹一下"），前一个窗口 `closed` 后再弹下一个。
 * 两条都不自动消失：用户没点掉，就一直挂着（58 §9 已确认的代价）。
 */

/** 队列上限：超出的只留会话区那条消息，不再弹 */
export const NOTICE_QUEUE_MAX = 5

/** 轻窗口高度（宽 = 工作区宽 × 0.3，见 §3.4 的表 / v0.58b 调整） */
const LIGHT_HEIGHT = 88
/** 重窗口尺寸 */
const STRONG_WIDTH = 480
const STRONG_HEIGHT = 300

let current: BrowserWindow | null = null
const queue: NotifyPayload[] = []

/** 屏高 1/8 处 / 正中，都按**工作区**算（不含任务栏） */
function boundsOf(level: NotifyPayload['level']): {
  x: number
  y: number
  width: number
  height: number
} {
  const area = screen.getPrimaryDisplay().workArea
  const strong = level === 'strong'
  const width = strong ? STRONG_WIDTH : Math.round(area.width * 0.3)
  const height = strong ? STRONG_HEIGHT : LIGHT_HEIGHT
  const x = area.x + Math.round((area.width - width) / 2)
  const y = strong
    ? area.y + Math.round((area.height - height) / 2)
    : area.y + Math.round(area.height * 0.125)
  return { x, y, width, height }
}

function openNotice(payload: NotifyPayload): void {
  const strong = payload.level === 'strong'
  const win = new BrowserWindow({
    ...boundsOf(payload.level),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences
  })
  current = win

  // 重窗口要能盖住全屏应用，轻窗口不该盖住全屏视频（与 HUD 同一条口径）
  win.setAlwaysOnTop(true, strong ? 'screen-saver' : 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true)

  // 内容要等 IPC 到了才有，所以先推负载再显示：反过来的话会闪一帧空窗
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.webContents.send(CH.notify.show, payload)
    win.showInactive() // 不抢焦点：用户正在别处打字时不该被截断
  })

  win.on('closed', () => {
    if (current === win) current = null
    const next = queue.shift()
    if (next !== undefined) openNotice(next)
  })

  // 页面没加载出来（打包漏了入口 / 文件被删）时 `ready-to-show` 永远不来，
  // 窗口就会一直占着单例位、后面的提醒全在队列里排队直到被丢弃。加载失败即销毁，
  // 让下一条至少还有机会；失败也把原因喊出来，不至于静默。
  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame) return
    console.error('[notify] 提醒页加载失败', code, description)
    if (!win.isDestroyed()) win.destroy()
  })

  loadRenderer(win, 'notify')
}

/** 弹一条提醒：没人占着窗口就直接开，否则入队（满 5 条丢弃） */
export function showNotice(payload: NotifyPayload): void {
  if (current !== null) {
    if (queue.length >= NOTICE_QUEUE_MAX) return
    queue.push(payload)
    return
  }
  openNotice(payload)
}

/**
 * 把队列里同一条提醒的副本剔掉（`reminder.snooze` 用）。
 *
 * 用户点了「稍后提醒」，这条提醒已经改到 15 分钟后再响；此刻队列里若还留着它的旧副本，
 * 关掉当前窗口后就会立刻再弹一次，等于稍后提醒失效。
 */
export function clearQueuedNotice(reminderId: string): void {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].reminderId === reminderId) queue.splice(i, 1)
  }
}

/** 清空所有提醒窗口（含队列）。退出前调用，避免 always-on-top 窗口残留 */
export function closeAllNotices(): void {
  queue.length = 0
  const win = current
  current = null
  if (win !== null && !win.isDestroyed()) win.destroy()
}
