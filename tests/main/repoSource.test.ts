import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 87 单 · 仓库直拉源的清单校验与落盘。全程注入假 fetch，不联网、不碰 net.fetch。
 * `electron` 整模块替换只是让 repoSource / github 顶层的 `import { net }` 能加载。
 */
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { downloadRepoTree, fetchRepoHead, parseRepoManifest } from '../../src/main/update/repoSource'

const REQUIRED_FILES = [
  'main/index.js',
  'preload/index.js',
  'renderer/main/index.html',
  'renderer/hud/index.html',
  'renderer/notify/index.html'
]

const manifestJson = (patch: Record<string, unknown>): string =>
  JSON.stringify({ version: '0.91.0', files: REQUIRED_FILES, ...patch })

/** 按 URL 返回 Response，形状对齐 `typeof fetch` 的第一个入参 */
const fakeFetch = (handler: (url: string) => Response): typeof fetch =>
  ((input: Parameters<typeof fetch>[0]) =>
    Promise.resolve(handler(typeof input === 'string' ? input : input.toString()))) as unknown as typeof fetch

describe('parseRepoManifest（仓库清单校验）', () => {
  it('合法清单原样返回；数组与 null 都不是普通对象', () => {
    expect(parseRepoManifest(manifestJson({}))).toEqual({
      version: '0.91.0',
      files: REQUIRED_FILES
    })
    expect(() => parseRepoManifest('[]')).toThrow('普通对象')
    expect(() => parseRepoManifest('null')).toThrow('普通对象')
  })

  it('缺 version → 抛错并指名 version', () => {
    expect(() => parseRepoManifest(JSON.stringify({ files: REQUIRED_FILES }))).toThrow('version')
  })

  it('version 是 0.91（少一段）→ 抛错', () => {
    expect(() => parseRepoManifest(manifestJson({ version: '0.91' }))).toThrow('形状不对')
  })

  it('files 为空 → 抛错', () => {
    expect(() => parseRepoManifest(manifestJson({ files: [] }))).toThrow('files')
  })

  it('元素含 ../x → 抛错；空串 / 反斜杠 / 根绝对路径同样不许', () => {
    expect(() =>
      parseRepoManifest(manifestJson({ files: [...REQUIRED_FILES, '../x'] }))
    ).toThrow('越界路径段')
    expect(() => parseRepoManifest(manifestJson({ files: [...REQUIRED_FILES, ''] }))).toThrow(
      '空文件名'
    )
    expect(() => parseRepoManifest(manifestJson({ files: [...REQUIRED_FILES, 'a\\b'] }))).toThrow(
      '反斜杠'
    )
    expect(() => parseRepoManifest(manifestJson({ files: [...REQUIRED_FILES, '/x'] }))).toThrow(
      '绝对路径'
    )
  })

  it('元素是 C:/x → 抛错', () => {
    expect(() =>
      parseRepoManifest(manifestJson({ files: [...REQUIRED_FILES, 'C:/x'] }))
    ).toThrow('绝对路径')
  })

  it('重复元素 → 抛错，不静默去重', () => {
    expect(() =>
      parseRepoManifest(manifestJson({ files: [...REQUIRED_FILES, 'main/index.js'] }))
    ).toThrow('重复元素')
  })

  it('缺关键文件（main/index.js 不在清单里）→ 抛错', () => {
    expect(() => parseRepoManifest(manifestJson({ files: REQUIRED_FILES.slice(1) }))).toThrow(
      '缺少关键文件'
    )
  })
})

describe('fetchRepoHead（87b 固化 commit sha）', () => {
  const SHA = 'abcdef1234567890abcdef1234567890abcdef12'

  it('正常返回 40 位 sha', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ sha: SHA }), { status: 200 }))
    await expect(fetchRepoHead(fetchImpl)).resolves.toBe(SHA)
  })

  it('sha 是 xyz → 抛错并挂 shape', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ sha: 'xyz' }), { status: 200 }))
    const err = await fetchRepoHead(fetchImpl).catch((e: unknown) => e)
    expect(String(err)).toContain('sha')
    expect((err as { failure?: string }).failure).toBe('shape')
  })
})

describe('downloadRepoTree（串行落盘 + 版本一致性）', () => {
  let staging: string

  beforeEach(() => {
    staging = mkdtempSync(join(tmpdir(), 'taskloop-repo-'))
  })

  afterEach(() => {
    rmSync(staging, { recursive: true, force: true })
  })

  const manifest = { version: '0.91.0', files: ['a.js', 'nested/b.css'] }

  it('两个文件 + package.json：返回 2 且文件内容正确', async () => {
    const fetchImpl = fakeFetch(url => {
      if (url.endsWith('/package.json')) {
        return new Response(JSON.stringify({ version: '0.91.0' }), { status: 200 })
      }
      if (url.endsWith('/out/a.js')) return new Response('AAA', { status: 200 })
      return new Response('BBB', { status: 200 })
    })

    expect(await downloadRepoTree(manifest, staging, null, fetchImpl)).toBe(2)
    expect(readFileSync(join(staging, 'out', 'a.js'), 'utf8')).toBe('AAA')
    expect(readFileSync(join(staging, 'out', 'nested', 'b.css'), 'utf8')).toBe('BBB')
    expect(JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')).version).toBe('0.91.0')
  })

  it('某文件返回 404 → 抛错且错误信息带该文件名', async () => {
    const fetchImpl = fakeFetch(url =>
      url.endsWith('/out/nested/b.css')
        ? new Response(null, { status: 404 })
        : new Response('AAA', { status: 200 })
    )
    await expect(downloadRepoTree(manifest, staging, null, fetchImpl)).rejects.toThrow('nested/b.css')
  })

  it('package.json 的 version 与清单不一致 → 抛错', async () => {
    const fetchImpl = fakeFetch(url =>
      url.endsWith('/package.json')
        ? new Response(JSON.stringify({ version: '0.90.0' }), { status: 200 })
        : new Response('AAA', { status: 200 })
    )
    await expect(downloadRepoTree(manifest, staging, null, fetchImpl)).rejects.toThrow('不一致')
  })

  it('每个 URL 都带 ref：传 sha 时含 /abc123/，传 null 时含 /master/', async () => {
    const urls: string[] = []
    const fetchImpl = fakeFetch(url => {
      urls.push(url)
      if (url.endsWith('/package.json')) {
        return new Response(JSON.stringify({ version: '0.91.0' }), { status: 200 })
      }
      return new Response('AAA', { status: 200 })
    })

    await downloadRepoTree(manifest, staging, 'abc123', fetchImpl)
    // 2 个 out 文件 + 1 次 package.json
    expect(urls).toHaveLength(3)
    expect(urls.every(url => url.includes('/abc123/'))).toBe(true)

    urls.length = 0
    await downloadRepoTree(manifest, staging, null, fetchImpl)
    expect(urls).toHaveLength(3)
    expect(urls.every(url => url.includes('/master/'))).toBe(true)
    expect(urls.some(url => url.includes('/null/'))).toBe(false)
  })
})
