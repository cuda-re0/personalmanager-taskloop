import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 更新服务（v0.60 起，v0.75 改走 GitHub Release，v0.83 补换装安全）。
 *
 * 只测版本比较、「检查更新」判定与覆盖/回滚的终局：网络层整模块 mock 掉，单测一律不联网。
 * ELECTRON_RUN_AS_NODE 下没有真实 app，electron 也要整模块替换。
 */
/** 可变的 exe 路径：覆盖/回滚用例把它指到临时沙箱 */
const exeHolder = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'exe' ? exeHolder.path : join(tmpdir(), 'taskloop-update-78'),
    getVersion: () => '0.75.0',
    isPackaged: false,
    relaunch: vi.fn(),
    quit: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../../src/main/update/github', () => ({
  fetchLatestRelease: vi.fn(),
  downloadPayload: vi.fn()
}))

vi.mock('../../src/main/update/repoSource', () => ({
  fetchRepoHead: vi.fn(),
  fetchRepoManifest: vi.fn(),
  downloadRepoTree: vi.fn()
}))

import { app } from 'electron'
import { downloadPayload, fetchLatestRelease } from '../../src/main/update/github'
import { downloadRepoTree, fetchRepoHead, fetchRepoManifest } from '../../src/main/update/repoSource'
import {
  applyUpdate,
  checkUpdate,
  compareVersion,
  isInstallIntact,
  REQUIRED_FILES
} from '../../src/main/update/updateService'

const fetchLatest = vi.mocked(fetchLatestRelease)
const download = vi.mocked(downloadPayload)
const fetchRepo = vi.mocked(fetchRepoManifest)
const fetchHead = vi.mocked(fetchRepoHead)
const downloadRepo = vi.mocked(downloadRepoTree)
const relaunch = vi.mocked(app.relaunch)
const quit = vi.mocked(app.quit)
const USER_DATA = join(tmpdir(), 'taskloop-update-78')

beforeEach(() => {
  fetchLatest.mockReset()
  download.mockReset()
  fetchHead.mockReset()
  // 默认能取到 commit sha：仓库源路径下所有用例都按「已固化」走
  fetchHead.mockResolvedValue('a'.repeat(40))
  fetchRepo.mockReset()
  // 默认仓库源不可用：所有既有用例继续走 Release 路径，断言一条都不用改
  fetchRepo.mockRejectedValue(new Error('repo unavailable'))
  downloadRepo.mockReset()
  relaunch.mockClear()
  quit.mockClear()
  rmSync(USER_DATA, { recursive: true, force: true })
})

const STATE_FILE = join(USER_DATA, 'update-state.json')
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

function writeStateFile(value: unknown): void {
  mkdirSync(USER_DATA, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(value), 'utf8')
}

/** 造一个「旧版本已装好」的 resources/app，关键资源齐全 */
function seedInstalledApp(root: string): string {
  const appDir = join(root, 'resources', 'app')
  for (const rel of REQUIRED_FILES) {
    const file = join(appDir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'old')
  }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ version: '0.75.0' }))
  return appDir
}

/** 一份只带 package.json、缺 out/** 的坏载荷 */
function brokenPayload(version: string): string {
  return JSON.stringify({
    version,
    files: { 'package.json': b64(JSON.stringify({ version })) }
  })
}

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

describe('checkUpdate（GitHub Release）', () => {
  it('远端 0.99.0 → 有更新且本次会装', async () => {
    fetchLatest.mockResolvedValue({
      version: '0.99.0',
      payloadUrl: 'https://example.com/payload.json'
    })
    const result = await checkUpdate()
    expect(result.hasUpdate).toBe(true)
    expect(result.applying).toBe(true)
  })

  it('远端与当前同版本 → 无更新', async () => {
    fetchLatest.mockResolvedValue({
      version: '0.75.0',
      payloadUrl: 'https://example.com/payload.json'
    })
    const result = await checkUpdate()
    expect(result.hasUpdate).toBe(false)
  })

  it('自动路径查 GitHub 失败 → 返回无更新，不抛', async () => {
    fetchLatest.mockRejectedValue(new Error('offline'))
    await expect(checkUpdate()).resolves.toMatchObject({ hasUpdate: false, applying: false })
  })

  it('manual 路径查 GitHub 失败 → 抛给设置页', async () => {
    fetchLatest.mockRejectedValue(new Error('offline'))
    await expect(checkUpdate({ manual: true })).rejects.toThrow('检查更新失败：无法访问 GitHub')
  })
})

describe('checkUpdate（仓库源优先，87 单）', () => {
  const repoManifest = {
    version: '0.99.0',
    files: [
      'main/index.js',
      'preload/index.js',
      'renderer/main/index.html',
      'renderer/hud/index.html',
      'renderer/notify/index.html'
    ]
  }

  it('仓库源可用 → latest 取清单版本，且不再查 Release', async () => {
    fetchRepo.mockResolvedValue(repoManifest)
    const result = await checkUpdate()
    expect(result.latest).toBe('0.99.0')
    expect(result.hasUpdate).toBe(true)
    expect(fetchLatest).not.toHaveBeenCalled()
  })

  it('仓库源失败、Release 成功 → 仍按 Release 版本判定 hasUpdate', async () => {
    fetchRepo.mockRejectedValue(new Error('raw 404'))
    fetchLatest.mockResolvedValue({
      version: '0.99.0',
      payloadUrl: 'https://example.com/payload.json'
    })
    const result = await checkUpdate()
    expect(result.latest).toBe('0.99.0')
    expect(result.hasUpdate).toBe(true)
    expect(fetchLatest).toHaveBeenCalledTimes(1)
  })

  it('取 commit sha 失败 → 降级用 master 仍走仓库源，不回退 Release', async () => {
    fetchHead.mockRejectedValue(new Error('rate limited'))
    fetchRepo.mockResolvedValue(repoManifest)
    const result = await checkUpdate()
    expect(result.latest).toBe('0.99.0')
    expect(result.hasUpdate).toBe(true)
    // 降级路径把 ref 传成 null（fetchRepoManifest 内部映射成 master），不能是 "null"
    expect(fetchRepo).toHaveBeenCalledWith(null)
    expect(fetchLatest).not.toHaveBeenCalled()
  })
})

describe('尝试标记（v0.83 带时间戳自愈）', () => {
  const remote = { version: '0.99.0', payloadUrl: 'https://example.com/payload.json' }

  it('标记在 24 小时内 → 自动路径不再装', async () => {
    writeStateFile({ version: '0.99.0', at: new Date().toISOString() })
    fetchLatest.mockResolvedValue(remote)
    const result = await checkUpdate()
    expect(result).toMatchObject({ hasUpdate: true, applying: false })
  })

  it('标记超过 24 小时 → 允许重试', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    writeStateFile({ version: '0.99.0', at: old })
    fetchLatest.mockResolvedValue(remote)
    const result = await checkUpdate()
    expect(result.applying).toBe(true)
  })

  it('旧格式（纯字符串、无 at）视为过期 → 允许重试', async () => {
    writeStateFile({ attemptedVersion: '0.99.0' })
    fetchLatest.mockResolvedValue(remote)
    const result = await checkUpdate()
    expect(result.applying).toBe(true)
  })

  it('manual 始终绕过拦截', async () => {
    writeStateFile({ version: '0.99.0', at: new Date().toISOString() })
    fetchLatest.mockResolvedValue(remote)
    const result = await checkUpdate({ manual: true })
    expect(result.applying).toBe(true)
  })

  it('装成功写下的标记是新格式（带 version 与 at）', async () => {
    fetchLatest.mockResolvedValue(remote)
    await checkUpdate()
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { version?: unknown; at?: unknown }
    expect(saved.version).toBe('0.99.0')
    expect(typeof saved.at).toBe('string')
  })
})

describe('applyUpdate 覆盖与回滚（v0.83）', () => {
  it('载荷缺关键资源 → 判失败并回滚，旧 out 原样恢复后再重启', async () => {
    const root = mkdtempSync(join(tmpdir(), 'taskloop-app-'))
    const appDir = seedInstalledApp(root)
    exeHolder.path = join(root, 'taskloop.exe')
    try {
      fetchLatest.mockResolvedValue({ version: '0.99.0', payloadUrl: 'https://example.com/p' })
      download.mockResolvedValue(brokenPayload('0.99.0'))

      await checkUpdate()
      await applyUpdate()

      // 旧版资源被恢复，备份已消费掉
      expect(readFileSync(join(appDir, 'out', 'main', 'index.js'), 'utf8')).toBe('old')
      expect(existsSync(join(appDir, 'out.bak'))).toBe(false)
      // 回滚成功 → 可以安全重启
      expect(relaunch).toHaveBeenCalledTimes(1)
      expect(quit).toHaveBeenCalledTimes(1)
    } finally {
      exeHolder.path = ''
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('回滚也失败 → 不 relaunch、不 quit，保留现场', async () => {
    const root = mkdtempSync(join(tmpdir(), 'taskloop-app-'))
    const appDir = join(root, 'resources', 'app')
    mkdirSync(appDir, { recursive: true })
    // 没有 out/、也没有 out.bak：覆盖失败后无从恢复
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ version: '0.75.0' }))
    exeHolder.path = join(root, 'taskloop.exe')
    try {
      fetchLatest.mockResolvedValue({ version: '0.99.0', payloadUrl: 'https://example.com/p' })
      download.mockResolvedValue(brokenPayload('0.99.0'))

      await checkUpdate()
      await applyUpdate()

      expect(relaunch).not.toHaveBeenCalled()
      expect(quit).not.toHaveBeenCalled()
    } finally {
      exeHolder.path = ''
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧版完好（关键资源齐全、版本对得上）→ isInstallIntact 为 true', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskloop-app-'))
    try {
      seedInstalledApp(root)
      expect(isInstallIntact(join(root, 'resources', 'app'), '0.75.0')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺一个关键文件 → isInstallIntact 为 false', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskloop-app-'))
    try {
      const appDir = seedInstalledApp(root)
      rmSync(join(appDir, 'out', 'renderer', 'hud', 'index.html'))
      expect(isInstallIntact(appDir, '0.75.0')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
