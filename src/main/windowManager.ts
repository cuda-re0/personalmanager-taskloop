import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import * as hudService from './services/hudService'
import type { HudDisplayArea, HudDisplaysPort, HudWindowPort, Rect } from './services/hudService'

const preloadPath = join(__dirname, '../preload/index.js')

type RendererPage = 'main' | 'hud'

/** 开发期走 dev server，打包后走 out/renderer/<page>/index.html */
function loadRenderer(win: BrowserWindow, page: RendererPage): void {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}/${page}/index.html`)
    return
  }
  void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

const webPreferences = {
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
} as const

/** 主窗：1440×920，普通可缩放窗口（04 §2 最小 680×520；< 1000px 时右栏收起为图标条） */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 680,
    minHeight: 520,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences
  })

  win.once('ready-to-show', () => win.show())

  // 外链不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win, 'main')
  return win
}

/** HUD 窗口句柄（`createHudWindow` 建、`getHudWindow` 取；关闭后返回 null） */
let hudWindow: BrowserWindow | null = null

interface DisplayLike {
  id: number
  workArea: { x: number; y: number; width: number; height: number }
}

/** 显示器端口：只取 `workArea`（`bounds` 含任务栏，会压到任务栏下面） */
function hudDisplaysPort(): HudDisplaysPort {
  const toArea = (display: DisplayLike): HudDisplayArea => ({
    displayId: display.id,
    workArea: {
      x: display.workArea.x,
      y: display.workArea.y,
      width: display.workArea.width,
      height: display.workArea.height
    }
  })

  return {
    // 记忆的显示器不在了（拔屏 / displayId 为 null）→ 回落主屏（04 §8）
    workAreaOf(displayId) {
      const found =
        displayId === null ? undefined : screen.getAllDisplays().find(d => d.id === displayId)
      return toArea(found ?? screen.getPrimaryDisplay())
    },
    nearestWorkArea(rect: Rect) {
      return toArea(screen.getDisplayMatching(rect))
    }
  }
}

/** 窗口端口：hudService 只通过这些动作碰窗口，测试可注入假实现 */
function hudWindowPort(win: BrowserWindow): HudWindowPort {
  return {
    getBounds: () => win.getBounds(),
    setBounds: rect => {
      if (!win.isDestroyed()) win.setBounds(rect)
    },
    setMovable: movable => {
      if (!win.isDestroyed()) win.setMovable(movable)
    },
    hide: () => {
      if (!win.isDestroyed()) win.hide()
    },
    showInactive: () => {
      if (!win.isDestroyed()) win.showInactive()
    },
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    onMove: listener => win.on('move', listener),
    isDestroyed: () => win.isDestroyed()
  }
}

/** HUD 窗口（未创建 / 已销毁时返回 null） */
export function getHudWindow(): BrowserWindow | null {
  return hudWindow && !hudWindow.isDestroyed() ? hudWindow : null
}

/**
 * HUD：透明置顶无边框（04 §5.1）。
 *
 * 尺寸与坐标不在这里算——由 `hudService` 按 `{ mode, expanded, displayId, position }` 决定，
 * 建窗前先取一次 `resolveInitialBounds`，避免"先按旧尺寸建出来再挪"的闪烁。
 */
export function createHudWindow(): BrowserWindow {
  const displays = hudDisplaysPort()
  const bounds = hudService.resolveInitialBounds(displays)

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    // 先按不可拖建出来，attach 里按模式 setMovable（dock-bar 不可拖，04 §5.2）
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    focusable: true,
    show: false,
    webPreferences
  })
  hudWindow = win

  // 用 'pop-up-menu' 而不是 'screen-saver'，避免盖住全屏视频（00 §6）
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true)

  // 透明窗白闪防护：ready-to-show 后以 inactive 方式出现，不抢焦点
  win.once('ready-to-show', () => win.showInactive())

  hudService.attach(hudWindowPort(win), displays)

  // 插拔屏 / 分辨率变化后重算 bounds，越界则归位（04 §8）
  const onDisplayChanged = (): void => {
    hudService.syncDisplays()
  }
  screen.on('display-removed', onDisplayChanged)
  screen.on('display-metrics-changed', onDisplayChanged)

  win.on('closed', () => {
    screen.removeListener('display-removed', onDisplayChanged)
    screen.removeListener('display-metrics-changed', onDisplayChanged)
    hudService.detach()
    if (hudWindow === win) hudWindow = null
  })

  loadRenderer(win, 'hud')
  return win
}
