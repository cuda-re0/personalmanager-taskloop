import { describe, expect, it } from 'vitest'
import { AUTOSTART_FLAG, isAutoStart, loginItemArgs } from '../../src/main/autoStart'

/**
 * 开机自启的纯逻辑（v0.46 §7）。
 *
 * `seedAutoStart()` 不在这里测：它要真注册表，且非 Electron 环境下必须静默 return
 * （由既有测试宿主顺带覆盖）。
 */

describe('isAutoStart', () => {
  it('只认精确等于 --autostart 的元素', () => {
    expect(isAutoStart(['electron.exe', '--autostart'])).toBe(true)
    expect(isAutoStart(['--autostart=true'])).toBe(false)
    expect(isAutoStart(['--auto'])).toBe(false)
    expect(isAutoStart([])).toBe(false)
  })
})

describe('loginItemArgs', () => {
  it('打包态：直接跑 exe，只带标记参数', () => {
    const item = loginItemArgs({
      isPackaged: true,
      execPath: 'C:\\app\\taskloop.exe',
      appPath: 'C:\\app\\resources\\app.asar'
    })
    expect(item.path).toBe('C:\\app\\taskloop.exe')
    expect(item.args).toEqual([AUTOSTART_FLAG])
  })

  it('开发态（路径不含空格）：electron.exe + 应用目录 + 标记', () => {
    const appPath = 'C:\\project\\taskloop'
    const item = loginItemArgs({
      isPackaged: false,
      execPath: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
      appPath
    })
    expect(item.path).toBe('C:\\project\\node_modules\\electron\\dist\\electron.exe')
    expect(item.args).toEqual([appPath, AUTOSTART_FLAG])
    // 不含空格就不加引号，原样传
    expect(item.args[0]).toBe(appPath)
  })

  it('开发态（路径含空格）：应用目录自己加一层双引号', () => {
    const item = loginItemArgs({
      isPackaged: false,
      execPath: 'C:\\electron\\electron.exe',
      appPath: 'C:\\Users\\me\\My App'
    })
    expect(item.args[0]).toBe('"C:\\Users\\me\\My App"')
    expect(item.args[1]).toBe(AUTOSTART_FLAG)
  })
})
