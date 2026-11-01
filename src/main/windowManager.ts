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

/**
 * 主窗：1440×920，普通可缩放窗口。
 *
 * 最小尺寸按两栏的真实下限取（v0.21）：会话区 `min-width:520` + 右栏固定 `400` = 920，
 * 加 20 余量取 940。原来的 680 是给「右栏收起成 48px 图标条」的响应式留的，
 * 那条一直没实现，680 直接导致两栏互相挤压、日历 7 列塌成几列、出现横向滚动条。
 * v0.26 右栏 400 → 460，下限同步 +40 取 980（520 + 460 = 980，不再留余量：
 * 窗口再小只会压到会话区，压破 min-width 就出横向滚动条）。
 */
/** 主窗句柄（`createMainWindow` 建、`getMainWindow` 取；关闭后返回 null） */
let mainWindow: BrowserWindow | null = null

/**
 * @param options.show `ready-to-show` 时是否显示，默认 `true`。
 * 开机自启传 `false`：窗口照建、渲染层照加载（IPC 照常就绪），只是不弹出来
 * ——用户从悬浮条点「打开主界面」再把它叫出来（46 §3.2）。
 */
export function createMainWindow(options: { show?: boolean } = {}): BrowserWindow {
  const showOnReady = options.show ?? true

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 560,
    show: false,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences
  })
  mainWindow = win

  win.once('ready-to-show', () => {
    if (showOnReady) win.show()
  })

  // 外链不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  loadRenderer(win, 'main')
  return win
}

/** 主窗（未创建 / 已销毁时返回 null） */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

/**
 * 叫出主窗（v0.46）：`second-instance` 与 `app.showMain` 的唯一入口。
 *
 * 主窗被 `×` 关掉时应用不退出（HUD 还在），此刻句柄是 null——重建一个，
 * 用户点「打开主界面」得到的是真窗口，不是空操作。
 */
export function showMainWindow(): void {
  const win = getMainWindow()
  if (!win) {
    createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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
    // 用 content bounds 而不是 outer bounds：Windows 给无边框可拉伸窗口加了一圈隐形边框，
    // `setBounds(360)` 回读是 362，反复"请求 = 回读"会让面板每开一次胖 2px（实测 372→374→376）。
    // content bounds 就是渲染层真实可视区域，和 CSS 的 100% 一一对应。
    getBounds: () => win.getContentBounds(),
    setBounds: rect => {
      if (!win.isDestroyed()) win.setContentBounds(rect)
    },
    setMovable: movable => {
      if (!win.isDestroyed()) win.setMovable(movable)
    },
    // 形态能力（04 §5.1）：面板可拉伸 + 上下限，长条固定 132×40。
    // 上下限必须动态设：建窗时就写 minWidth=280 的话，长条 setBounds 到 132 会被系统夹住。
    setResizable: resizable => {
      if (!win.isDestroyed()) win.setResizable(resizable)
    },
    setMinSize: (width, height) => {
      if (!win.isDestroyed()) win.setMinimumSize(width, height)
    },
    setMaxSize: (width, height) => {
      if (!win.isDestroyed()) win.setMaximumSize(width, height)
    },
    hide: () => {
      if (!win.isDestroyed()) win.hide()
    },
    showInactive: () => {
      if (!win.isDestroyed()) win.showInactive()
    },
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    onMove: listener => {
      win.on('move', () => listener())
    },
    onResize: listener => {
      win.on('resize', () => listener())
    },
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
 * 尺寸与坐标不在这里算——由 `hudService` 按 `{ mode, displayId, position, size }` 决定，
 * 建窗前先取一次 `resolveInitialBounds`，避免"先按旧尺寸建出来再挪"的闪烁。
 *
 * v0.30：建窗时**不写** minWidth/minHeight——那张上下限只对面板有效，建窗即生效会把
 * 长条（132×40）夹在 280×320 上。`resizable` / 上下限都由 `hudService.applyWindowMode()` 按形态动态设。
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
    // 长条与面板都可拖（面板只有头部是 drag 区），attach 里仍按形态调一次
    movable: true,
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

  // 插拔屏 / 分辨率变化后重算 bounds，越界则归位（04 §8）。
  // display-added 也要挂：新屏接上后工作区布局变了，不重算 HUD 会留在旧屏的坐标上。
  const onDisplayChanged = (): void => {
    hudService.syncDisplays()
  }
  screen.on('display-added', onDisplayChanged)
  screen.on('display-removed', onDisplayChanged)
  screen.on('display-metrics-changed', onDisplayChanged)

  win.on('closed', () => {
    screen.removeListener('display-added', onDisplayChanged)
    screen.removeListener('display-removed', onDisplayChanged)
    screen.removeListener('display-metrics-changed', onDisplayChanged)
    hudService.detach()
    if (hudWindow === win) hudWindow = null
  })

  loadRenderer(win, 'hud')
  return win
}
