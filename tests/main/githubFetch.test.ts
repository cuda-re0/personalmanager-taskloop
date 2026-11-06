import { describe, expect, it, vi } from 'vitest'

/**
 * 78b · `fetchLatestRelease` 的失败分档。全程注入假 fetch，不联网、不碰 `net`。
 * `electron` 整模块替换只是为了让 `github.ts` 顶层的 `import { net } from 'electron'`
 * 在 ELECTRON_RUN_AS_NODE 下能加载；本文件不会调用 `net.fetch`。
 */
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { fetchLatestRelease } from '../../src/main/update/github'

/** 把「返回 Response」或「抛错」包成 `typeof fetch` 的形状 */
const fakeFetch = (run: () => Promise<Response>): typeof fetch =>
  (() => run()) as unknown as typeof fetch

const failureOf = async (
  fetchImpl: typeof fetch
): Promise<{ failure?: string; message?: string }> =>
  (await fetchLatestRelease(fetchImpl).catch((e: unknown) => e)) as {
    failure?: string
    message?: string
  }

describe('fetchLatestRelease 失败分档', () => {
  it('404 → notfound', async () => {
    const err = await failureOf(fakeFetch(() => Promise.resolve(new Response(null, { status: 404 }))))
    expect(err.failure).toBe('notfound')
  })

  it('500 → http', async () => {
    const err = await failureOf(fakeFetch(() => Promise.resolve(new Response(null, { status: 500 }))))
    expect(err.failure).toBe('http')
  })

  it('fetch 抛错 → network，且保留原始 message', async () => {
    const err = await failureOf(fakeFetch(() => Promise.reject(new Error('boom'))))
    expect(err.failure).toBe('network')
    expect(err.message).toBe('boom')
  })

  it('200 但没有 payload.json → shape', async () => {
    const body = JSON.stringify({ tag_name: 'v0.99.0', assets: [] })
    const err = await failureOf(fakeFetch(() => Promise.resolve(new Response(body, { status: 200 }))))
    expect(err.failure).toBe('shape')
  })

  it('tag 是预发布版 → shape，不当正式版装（v0.83）', async () => {
    const body = JSON.stringify({
      tag_name: 'v0.80.0-beta.1',
      assets: [{ name: 'payload.json', browser_download_url: 'https://example.com/payload.json' }]
    })
    const err = await failureOf(fakeFetch(() => Promise.resolve(new Response(body, { status: 200 }))))
    expect(err.failure).toBe('shape')
  })

  it('tag 少于三段 → shape（v0.83）', async () => {
    const body = JSON.stringify({
      tag_name: 'v0.80',
      assets: [{ name: 'payload.json', browser_download_url: 'https://example.com/payload.json' }]
    })
    const err = await failureOf(fakeFetch(() => Promise.resolve(new Response(body, { status: 200 }))))
    expect(err.failure).toBe('shape')
  })

  it('正常路径返回 version（去 v 前缀）与 payloadUrl', async () => {
    const body = JSON.stringify({
      tag_name: 'v0.99.0',
      assets: [{ name: 'payload.json', browser_download_url: 'https://example.com/payload.json' }]
    })
    const info = await fetchLatestRelease(fakeFetch(() => Promise.resolve(new Response(body, { status: 200 }))))
    expect(info).toEqual({ version: '0.99.0', payloadUrl: 'https://example.com/payload.json' })
  })
})
