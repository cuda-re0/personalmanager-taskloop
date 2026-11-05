import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

/**
 * 更新服务的纯逻辑部分（v0.60）。
 *
 * 只测「版本比较」与「manifest 读不到时不许炸」——这两条是更新检查的地基：
 * 版本比错会让应用每次启动都重启，读 manifest 抛异常会让应用根本起不来。
 *
 * ELECTRON_RUN_AS_NODE 下没有真实 app：模块顶层要 `app.getPath('userData')`，
 * 所以整模块 mock 掉 electron（本文件不碰窗口、不碰 IPC，替换无副作用）。
 */
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getVersion: () => '0.59.0',
    isPackaged: false,
    quit: vi.fn()
  }
}))

import { compareVersion, readManifest } from '../../src/main/update/updateService'

describe('compareVersion（新版本判定）', () => {
  it('0.60.0 比 0.59.9 新', () => {
    expect(compareVersion('0.60.0', '0.59.9')).toBe(1)
  })

  it('段数不同按缺省 0：0.60 与 0.60.0 相等', () => {
    expect(compareVersion('0.60', '0.60.0')).toBe(0)
  })

  it('逐段比数字，不是比字符串：0.9.0 比 0.10.0 旧', () => {
    expect(compareVersion('0.9.0', '0.10.0')).toBe(-1)
  })
})

describe('readManifest', () => {
  it('目录不存在 → null，不抛异常', () => {
    const missing = join(tmpdir(), 'taskloop-absent-updates-60')
    expect(readManifest(missing)).toBeNull()
  })
})
