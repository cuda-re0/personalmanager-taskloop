/**
 * 87 单 · 仓库直拉更新源（版本与文件清单直接读仓库，git push 即发布）。
 *
 * 87b：`master` 分支在 raw 上的缓存是**按文件**刷新的，推送后一段时间里
 * `out/manifest.json` 可能已是新版、`package.json` 还是旧版。所以先用 GitHub API
 * 取一次 `master` 的 commit sha，之后清单与所有文件都按 `<repo>/<sha>/...` 拉——
 * 同一个 commit 下的文件必然彼此一致。取不到 sha（限流、API 不可达）才降级用 `master`，
 * 那条路仍由末尾的 `package.json` 版本校验兜底。
 */

import { net } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { OWNER, REPO } from './github'

const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}`
const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const UA = 'taskloop-updater'
const TIMEOUT_MS = 10_000
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
    if (res.status === 404) throw withFailure(new Error('仓库里没有 master 分支'), 'notfound')
    if (!res.ok) throw withFailure(new Error(`GitHub API 返回 ${res.status}`), 'http')

    let body: unknown
    try {
      body = await res.json()
    } catch (e) {
      throw withFailure(e, 'shape')
    }
    const sha = isPlainObject(body) ? body.sha : undefined
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw withFailure(new Error('commits/master 的 sha 缺失或形状不对'), 'shape')
    }
    return sha
  } finally {
    clearTimeout(timer)
  }
}

/** 取 `out/manifest.json`；`ref` 为 null 走 master；失败按 notfound / http / network / shape 分档 */
export async function fetchRepoManifest(
  ref: string | null,
  fetchImpl: typeof fetch = chromiumFetch
): Promise<RepoManifest> {
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
      throw withFailure(new Error('仓库里没有 out/manifest.json'), 'notfound')
    }
    if (!res.ok) throw withFailure(new Error(`raw 返回 ${res.status}`), 'http')

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
      throw withFailure(e, 'shape')
    }
  } finally {
    clearTimeout(timer)
  }
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
  let total = 0
  let written = 0

  for (const rel of manifest.files) {
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
        throw new Error(`下载 ${rel} 失败：${e instanceof Error ? e.message : String(e)}`)
      }
      if (!res.ok) throw new Error(`下载 ${rel} 失败：状态码 ${res.status}`)

      const declared = Number(res.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
        throw new Error(`下载 ${rel} 失败：单文件超过 8 MiB`)
      }
      const body = Buffer.from(await res.arrayBuffer())
      if (body.byteLength === 0) throw new Error(`下载 ${rel} 失败：内容为空`)
      if (body.byteLength > MAX_FILE_BYTES) {
        throw new Error(`下载 ${rel} 失败：单文件超过 8 MiB`)
      }
      total += body.byteLength
      if (total > MAX_TOTAL_BYTES) throw new Error(`下载 ${rel} 失败：总量超过 32 MiB`)

      const target = resolve(outRoot, rel)
      if (!target.startsWith(prefix)) {
        console.warn(`[update] 跳过越界文件：${rel}`)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body)
      written += 1
    } finally {
      clearTimeout(timer)
    }
  }

  const pkgFile = join(root, 'package.json')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${base}/package.json`, {
      headers: { 'User-Agent': UA },
      signal: controller.signal
    })
    if (!res.ok) throw new Error(`下载 package.json 失败：状态码 ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    if (body.byteLength === 0) throw new Error('下载 package.json 失败：内容为空')
    writeFileSync(pkgFile, body)
  } finally {
    clearTimeout(timer)
  }

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
    throw new Error(
      `仓库 package.json 版本 ${String(landed)} 与清单 ${manifest.version} 不一致`
    )
  }

  return written
}
