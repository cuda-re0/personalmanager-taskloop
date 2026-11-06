/**
 * 87 单 · 仓库直拉更新源（版本与文件清单直接读仓库，git push 即发布）。
 *
 * 87b：`master` 分支在 raw 上的缓存是**按文件**刷新的，推送后一段时间里
 * `out/manifest.json` 可能已是新版、`package.json` 还是旧版。所以先用 GitHub API
 * 取一次 `master` 的 commit sha，之后清单与所有文件都按 `<repo>/<sha>/...` 拉——
 * 同一个 commit 下的文件必然彼此一致。取不到 sha（限流、API 不可达）才降级用 `master`，
 * 那条路仍由末尾的 `package.json` 版本校验兜底。
 *
 * 87c：冷缓存下单个文件要 11~12 秒（旧的 10 秒超时会把自己 abort 掉），且偶发
 * `net::ERR_HTTP2_PROTOCOL_ERROR`。所以超时放宽到 20 秒，网络错误 / 超时 / 5xx 自动重试
 * （最多 3 次尝试），404 / 4xx / 校验失败一律不重试。
 */

import { net } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { OWNER, REPO } from './github'

const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}`
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const UA = 'taskloop-updater'
/**
 * 87c：实测冷缓存下 `out/manifest.json` 要 11.2 秒、`renderer/assets/notify-*.js` 12.2 秒，
 * 10 秒会把自己的请求 abort 掉。放宽到 20 秒，并配合 `withRetry` 兜偶发的协议错误。
 */
const TIMEOUT_MS = 20_000
/** 含首次：最多 3 次尝试，即重试 2 次 */
const MAX_ATTEMPTS = 3
/** 第 N 次重试前等 N × 500ms（500 / 1000） */
const RETRY_DELAY_MS = 500
/** `downloadRepoTree` 整体预算：15 个文件 × 3 次 × 20 秒能拖很久，兜一个上限 */
const TOTAL_BUDGET_MS = 5 * 60 * 1000
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_FILES = 200

export interface RepoManifest {
  version: string
  files: string[]
}

/**
 * 与 `updateService.REQUIRED_FILES` / `scripts/make-manifest.mjs` 同口径（这里相对 `out/`）。
 * 少一个关键文件，装完就是白屏，而且版本号已变、自动路径再也不会自愈重装。
 */
const REQUIRED_FILES = [
  'main/index.js',
  'preload/index.js',
  'renderer/main/index.html',
  'renderer/hud/index.html',
  'renderer/notify/index.html'
] as const

/** 与 github.ts 的 failure 分档同名，checkUpdate 才能沿用原来的错误提示 */
type FailureKind = 'notfound' | 'http' | 'network' | 'shape'

/**
 * `ref` 为 `null` 时用 `master` 分支（87b 取不到 commit sha 时的降级路径）。
 * 必须显式映射，绝不能把 `null` 拼进 URL 变成字面量 "null"。
 */
const refOf = (ref: string | null): string => (ref === null ? 'master' : ref)

function withFailure(err: unknown, failure: FailureKind): Error {
  const error = err instanceof Error ? err : new Error(String(err))
  Object.assign(error, { failure })
  return error
}

/**
 * 给错误打「不许重试」标记后原样返回（87c）。
 *
 * 404、4xx、解析/校验失败、超限、版本不一致——重试一万次也是同样结果，
 * 重试只会让一次注定失败的操作多花几十秒。
 */
function nonRetryable(err: unknown, failure?: FailureKind): Error {
  const error =
    failure === undefined
      ? err instanceof Error
        ? err
        : new Error(String(err))
      : withFailure(err, failure)
  Object.assign(error, { retryable: false })
  return error
}

/** 未标 `retryable: false` 的错误一律视为可重试（网络错误、超时 abort、5xx） */
const isRetryable = (err: unknown): boolean =>
  (err as { retryable?: boolean } | null)?.retryable !== false

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms)
  })

/**
 * 87c：可重试的失败自动重试（最多 `MAX_ATTEMPTS` 次）。
 *
 * `fn` 每次调用都要自己新建 `AbortController` 与计时器——控制器提到外面复用会让
 * 第二次尝试带着已 abort 的信号，永远失败。
 *
 * `label` 只用于日志（`取 commit sha` / `取清单` / `下载 <rel>` / `取 package.json`）。
 */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
      if (!isRetryable(e)) throw e
      if (attempt === MAX_ATTEMPTS) break
      const wait = RETRY_DELAY_MS * attempt
      console.warn(
        `[update] ${label} 第 ${attempt} 次失败，${wait}ms 后重试：${e instanceof Error ? e.message : String(e)}`
      )
      await delay(wait)
    }
  }
  throw lastError
}

/**
 * `net.fetch` 走 Chromium 网络栈（读 Windows 受信任根证书库、跟随系统代理）。
 * 与 github.ts 一样只在调用期取 `net` 引用，模块加载期不碰它。
 */
const chromiumFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
  net.fetch(input instanceof URL ? input.toString() : input, init)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertSafeRel(rel: string): void {
  if (rel.length === 0) throw new Error('清单里出现空文件名')
  if (rel.includes('\\')) throw new Error(`清单文件名含反斜杠：${rel}`)
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`清单文件名是绝对路径：${rel}`)
  }
  if (rel.split('/').includes('..')) throw new Error(`清单文件名含越界路径段：${rel}`)
}

/** 清单解析：形状、路径安全、去重、关键文件齐全，一条不过就抛错并指名哪一条 */
export function parseRepoManifest(raw: string): RepoManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('清单不是合法 JSON')
  }
  if (!isPlainObject(parsed)) throw new Error('清单必须是普通对象（非数组、非 null）')

  const version = parsed.version
  if (typeof version !== 'string') throw new Error('清单缺少 version 或不是字符串')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`清单 version 形状不对：${version}`)

  const files = parsed.files
  if (!Array.isArray(files) || files.length === 0) throw new Error('清单 files 为空或不是数组')
  if (files.length > MAX_FILES) throw new Error(`清单 files 超过 ${MAX_FILES} 个`)

  const seen = new Set<string>()
  for (const rel of files) {
    if (typeof rel !== 'string') throw new Error('清单 files 里有非字符串元素')
    assertSafeRel(rel)
    if (seen.has(rel)) throw new Error(`清单 files 里有重复元素：${rel}`)
    seen.add(rel)
  }

  const missing = REQUIRED_FILES.filter(rel => !seen.has(rel))
  if (missing.length > 0) throw new Error(`清单缺少关键文件：${missing.join('、')}`)

  return { version, files: files as string[] }
}

/**
 * 取 `master` 当前指向的 commit sha（87b）。
 *
 * 只用它来固化后续所有拉取的位置：同一 commit 下的文件必然一致，不会再出现
 * 「清单已刷新、package.json 还是旧版」的混装。只读 `sha` 一个字段，不解析其它内容。
 * 失败按 notfound / http / network / shape 分档，由调用方决定降级还是回退 Release。
 */
export async function fetchRepoHead(
  fetchImpl: typeof fetch = chromiumFetch
): Promise<string> {
  return withRetry(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await fetchImpl(`${API}/commits/master`, {
          headers: { 'User-Agent': UA },
          signal: controller.signal
        })
      } catch (e) {
        throw withFailure(e, 'network')
      }
      if (res.status === 404) {
        throw nonRetryable(new Error('仓库里没有 master 分支'), 'notfound')
      }
      if (!res.ok) {
        const error = new Error(`GitHub API 返回 ${res.status}`)
        throw res.status < 500 ? nonRetryable(error, 'http') : withFailure(error, 'http')
      }

      let body: unknown
      try {
        body = await res.json()
      } catch (e) {
        throw nonRetryable(e, 'shape')
      }
      const sha = isPlainObject(body) ? body.sha : undefined
      if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
        throw nonRetryable(new Error('commits/master 的 sha 缺失或形状不对'), 'shape')
      }
      return sha
    } finally {
      clearTimeout(timer)
    }
  }, '取 commit sha')
}

/** 取 `out/manifest.json`；`ref` 为 null 走 master；失败按 notfound / http / network / shape 分档 */
export async function fetchRepoManifest(
  ref: string | null,
  fetchImpl: typeof fetch = chromiumFetch
): Promise<RepoManifest> {
  return withRetry(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      let res: Response
      try {
        res = await fetchImpl(`${RAW}/${refOf(ref)}/out/manifest.json`, {
          headers: { 'User-Agent': UA },
          signal: controller.signal
        })
      } catch (e) {
        throw withFailure(e, 'network')
      }
      if (res.status === 404) {
        throw nonRetryable(new Error('仓库里没有 out/manifest.json'), 'notfound')
      }
      if (!res.ok) {
        const error = new Error(`raw 返回 ${res.status}`)
        throw res.status < 500 ? nonRetryable(error, 'http') : withFailure(error, 'http')
      }

      try {
        const declared = Number(res.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
          throw new Error('清单超过 1 MiB')
        }
        const body = await res.text()
        if (Buffer.byteLength(body, 'utf8') > MAX_MANIFEST_BYTES) {
          throw new Error('清单超过 1 MiB')
        }
        return parseRepoManifest(body)
      } catch (e) {
        throw nonRetryable(e, 'shape')
      }
    } finally {
      clearTimeout(timer)
    }
  }, '取清单')
}

/**
 * 按清单串行下载 `out/**` 到 staging，再单拉一次 `package.json`。
 *
 * `ref` 与清单同源（87b 的 commit sha，或降级时的 null → master），保证这批文件
 * 都来自同一个 commit。
 *
 * 两条源产出的 staging 结构完全一致：`staging/out/**` + `staging/package.json`。
 * 任一文件失败直接抛给调用方，清 staging 由调用方统一做。
 */
export async function downloadRepoTree(
  manifest: RepoManifest,
  stagingDir: string,
  ref: string | null,
  fetchImpl: typeof fetch = chromiumFetch
): Promise<number> {
  const base = `${RAW}/${refOf(ref)}`
  const root = resolve(stagingDir)
  const outRoot = resolve(root, 'out')
  const prefix = outRoot + sep
  const startedAt = Date.now()
  let total = 0
  let written = 0

  for (const rel of manifest.files) {
    // 整体预算：文件多 + 网络差时 15 个文件 × 3 次 × 20 秒能拖很久。不重试，直接放弃这次更新。
    if (Date.now() - startedAt > TOTAL_BUDGET_MS) {
      throw new Error('仓库源下载超时：已用超过 5 分钟')
    }

    const body = await withRetry(async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        let res: Response
        try {
          res = await fetchImpl(`${base}/out/${rel}`, {
            headers: { 'User-Agent': UA },
            signal: controller.signal
          })
        } catch (e) {
          // 网络错误 / 超时 abort：可重试
          throw new Error(`下载 ${rel} 失败：${e instanceof Error ? e.message : String(e)}`)
        }
        if (!res.ok) {
          const error = new Error(`下载 ${rel} 失败：状态码 ${res.status}`)
          // 4xx（含 403 限流）重试也是同样结果；5xx 值得再试
          throw res.status < 500 ? nonRetryable(error) : error
        }

        const declared = Number(res.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：单文件超过 8 MiB`))
        }
        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.byteLength === 0) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：内容为空`))
        }
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：单文件超过 8 MiB`))
        }
        total += bytes.byteLength
        if (total > MAX_TOTAL_BYTES) {
          throw nonRetryable(new Error(`下载 ${rel} 失败：总量超过 32 MiB`))
        }
        return bytes
      } finally {
        clearTimeout(timer)
      }
    }, `下载 ${rel}`)

    const target = resolve(outRoot, rel)
    if (!target.startsWith(prefix)) {
      console.warn(`[update] 跳过越界文件：${rel}`)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    written += 1
  }

  const pkgFile = join(root, 'package.json')
  const pkgBody = await withRetry(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetchImpl(`${base}/package.json`, {
        headers: { 'User-Agent': UA },
        signal: controller.signal
      })
      if (!res.ok) {
        const error = new Error(`下载 package.json 失败：状态码 ${res.status}`)
        throw res.status < 500 ? nonRetryable(error) : error
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.byteLength === 0) {
        throw nonRetryable(new Error('下载 package.json 失败：内容为空'))
      }
      return bytes
    } finally {
      clearTimeout(timer)
    }
  }, '取 package.json')
  writeFileSync(pkgFile, pkgBody)

  // 87b 起 URL 已按 commit sha 固化，正常不会混装；这条校验留着兜降级路径（ref 为 null
  // 时仍按 master 拉，raw 的 CDN 缓存约 5 分钟，可能出现「清单是新的、文件是旧的」）。
  // 版本对不上就当这次没更新，绝不把混装目录覆盖进 resources/app。
  let landed: unknown
  try {
    landed = JSON.parse(readFileSync(pkgFile, 'utf8')).version
  } catch (e) {
    throw new Error(`仓库 package.json 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  if (landed !== manifest.version) {
    // 这条校验在重试范围之外，打标记只是把「重试无意义」的意图写在类型上
    throw nonRetryable(
      new Error(`仓库 package.json 版本 ${String(landed)} 与清单 ${manifest.version} 不一致`)
    )
  }

  return written
}
