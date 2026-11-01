import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 开机自启（v0.46）。
 *
 * 没有界面开关：首次运行就写注册表，此后靠一个标记文件保证**永不再碰注册表**——
 * 用户手动删掉 Run 键项也不会被写回（46 §5，刻意如此）。
 *
 * 开发期的坑：Run 键里存的是 `electron.exe <appPath> --autostart`，`appPath` 含空格时
 * 必须自己加一层双引号——Windows 把 path + args 空格拼成一条命令行，Electron 不会替
 * 每个 arg 加引号，含空格的参数会被拆开、应用起不来。
 */

/** 自启标记参数：全项目唯一一处字面量，别处一律引用这个常量 */
export const AUTOSTART_FLAG = '--autostart'

/** 标记文件：存在即"已播过种"。内容只为排查，不参与判断 */
const SEEDED_FILE = 'autostart.seeded'

/** 精确匹配：`--autostart=true` / `--auto` 都不算 */
export function isAutoStart(argv: string[]): boolean {
  return argv.some(arg => arg === AUTOSTART_FLAG)
}

/**
 * Run 键的 `path` + `args`。
 *
 * 打包态直接跑 exe；开发期跑的是 `electron.exe`，必须把应用目录当第一个参数传进去，
 * 否则 electron 会去开默认窗口。
 */
export function loginItemArgs(opts: {
  isPackaged: boolean
  execPath: string
  appPath: string
}): { path: string; args: string[] } {
  if (opts.isPackaged) {
    return { path: opts.execPath, args: [AUTOSTART_FLAG] }
  }
  const appArg = opts.appPath.includes(' ') ? `"${opts.appPath}"` : opts.appPath
  return { path: opts.execPath, args: [appArg, AUTOSTART_FLAG] }
}

/** 与 `ai/config.ts` 同款判定：测试宿主（`ELECTRON_RUN_AS_NODE`）下 `app` 不是对象 */
function hasApp(): boolean {
  return typeof app === 'object' && app !== null && typeof app.getPath === 'function'
}

function warn(step: string, e: unknown): void {
  const name = e instanceof Error ? e.name : String(e)
  console.warn(`[autostart] ${step} 失败`, name)
}

/**
 * 一次性播种（幂等、永不抛）。
 *
 * 写注册表失败也照样写标记：环境问题重试无意义，反复重试只会每次启动都碰一次注册表。
 */
export function seedAutoStart(): void {
  if (!hasApp()) return

  let flagPath: string
  try {
    flagPath = join(app.getPath('userData'), SEEDED_FILE)
    if (existsSync(flagPath)) return
  } catch (e) {
    warn('取标记文件路径', e)
    return
  }

  try {
    if (app.getLoginItemSettings().openAtLogin !== true) {
      app.setLoginItemSettings({
        openAtLogin: true,
        ...loginItemArgs({
          isPackaged: app.isPackaged,
          execPath: process.execPath,
          appPath: app.getAppPath()
        })
      })
    }
  } catch (e) {
    warn('写开机启动项', e)
  }

  try {
    writeFileSync(flagPath, new Date().toISOString(), 'utf8')
  } catch (e) {
    warn('写标记文件', e)
  }
}
