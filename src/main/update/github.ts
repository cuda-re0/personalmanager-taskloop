/** 78 单 · GitHub Release 查询与载荷下载。默认走 Chromium 网络栈，网络层可注入假 fetch 做单测。 */

import { net } from 'electron'

const OWNER = 'cuda-re0'
const REPO = 'personalmanager-taskloop'
const RELEASES_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`
const UA = 'taskloop-updater'

/** 78b：检查更新要把「没发过 Release」和「连不上」在界面上分开 */
type FailureKind = 'notfound' | 'http' | 'network' | 'shape'

export interface ReleaseInfo {
  version: string
  payloadUrl: string
}

/**
 * Electron 的 `net.fetch` 走 Chromium 网络栈：读 Windows 受信任根证书库、跟随系统代理。
 * 裸 `fetch` 是 Node 实现，只认自带 CA 列表——hosts 把 api.github.com 指到 127.0.0.1、
 * 本地代理用自签根证书（Steam++ 之类）时，TLS 握手直接失败。
 *
 * `net.fetch` 只能在 `app.ready` 之后调用，所以这里只做转发，不在模块加载期取引用。
 */
const chromiumFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
  net.fetch(input instanceof URL ? input.toString() : input, init)

/** 给异常挂 `failure` 标记；非 Error 包成 Error，Error 原对象保留（原始 message 不丢） */
function withFailure(err: unknown, failure: FailureKind): Error {
  const error = err instanceof Error ? err : new Error(String(err))
  Object.assign(error, { failure })
  return error
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = chromiumFetch): Promise<ReleaseInfo> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    let res: Response
    try {
      res = await fetchImpl(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA },
        signal: controller.signal
      })
    } catch (e) {
      // 网络 / TLS / 超时 abort：原错误对象保留，只挂标记后重新抛
      throw withFailure(e, 'network')
    }
    if (res.status === 404) throw withFailure(new Error('GitHub 返回 404'), 'notfound')
    if (!res.ok) throw withFailure(new Error(`GitHub 返回 ${res.status}`), 'http')

    const data = (await res.json()) as { tag_name?: unknown; assets?: unknown }
    if (typeof data?.tag_name !== 'string') throw withFailure(new Error('Release 缺少 tag_name'), 'shape')
    const version = data.tag_name.replace(/^[vV]/, '').trim()
    if (version === '') throw withFailure(new Error('Release 的 tag_name 为空'), 'shape')
    // v0.83：只认 `X.Y.Z`。`0.80.0-beta.1` 之类不能被 compareVersion 当成正式版装上去
    // （那个函数会把非数字段按 0 处理，`0.78.0-beta.1` 反而比 `0.77.0` 大）。
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw withFailure(new Error('Release 的 tag_name 形状不对'), 'shape')
    }

    const assets = Array.isArray(data.assets) ? data.assets : []
    const asset = assets.find(
      (item): item is { browser_download_url?: unknown } =>
        item !== null &&
        typeof item === 'object' &&
        (item as { name?: unknown }).name === 'payload.json'
    )
    const payloadUrl = asset?.browser_download_url
    if (typeof payloadUrl !== 'string' || payloadUrl.trim() === '') {
      throw withFailure(new Error('Release 里没有 payload.json'), 'shape')
    }
    return { version, payloadUrl: payloadUrl.trim() }
  } finally {
    clearTimeout(timer)
  }
}

/** v0.83：载荷字节上限。正常包约 1.1 MB，超这个量级只可能是坏包或恶意包 */
const MAX_PAYLOAD_BYTES = 40 * 1024 * 1024

export async function downloadPayload(
  url: string,
  fetchImpl: typeof fetch = chromiumFetch
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`下载载荷失败：${res.status}`)

    // 先看声明长度，能在读正文之前就拒掉
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
      controller.abort()
      throw new Error('下载载荷超过 40 MiB')
    }

    // 没有流（部分注入式假 fetch）时退回整读，但仍要过一遍上限
    if (res.body === null) {
      const text = await res.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD_BYTES) {
        throw new Error('下载载荷超过 40 MiB')
      }
      return text
    }

    // 流式累计，超限立刻 abort，不留一个无界增长的 Buffer
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PAYLOAD_BYTES) {
        controller.abort()
        throw new Error('下载载荷超过 40 MiB')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    clearTimeout(timer)
  }
}
