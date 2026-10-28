import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'

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

/** 主窗：1440×920，普通可缩放窗口（04 §2 最小 1180×760） */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
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

/** HUD：300×32 透明置顶无边框，贴主屏左上角（04 §5.1） */
export function createHudWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay()

  const win = new BrowserWindow({
    width: 300,
    height: 32,
    x: workArea.x + 8,
    y: workArea.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
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

  // 用 'pop-up-menu' 而不是 'screen-saver'，避免盖住全屏视频（00 §6）
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.setVisibleOnAllWorkspaces(true)

  // 透明窗白闪防护：ready-to-show 后以 inactive 方式出现，不抢焦点
  win.once('ready-to-show', () => win.showInactive())

  loadRenderer(win, 'hud')
  return win
}
