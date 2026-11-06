import { app, BrowserWindow } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { CheckResult } from '../../shared/types/ipc'
import { appError } from '../db/errors'
import { downloadPayload, fetchLatestRelease } from './github'
import { parsePayload, writePayloadTree } from './payload'
import { downloadRepoTree, fetchRepoManifest, type RepoManifest } from './repoSource'

/**
 * 本机绿色版自更新（v0.60 起，v0.75 改走 GitHub Release，87 单起仓库直拉优先）。
 *
 * 形态：先读仓库 `out/manifest.json`，失败才回退 GitHub Release 的 `payload.json`；
 * 两条路都解到 `userData/update-staging`，再由主进程**在进程内覆盖** `resources/app` 并 relaunch。
 * 不再读 exe 同级的 `updates/`；不校验签名、不算 sha256。
 *
 * v0.60b 起覆盖由本文件自己做：Node `fs` 在 Unicode 路径下没有 cmd/bat 的代码页问题，
 * 失败就回滚并照常启动——最坏结果是"这次没更新"，不是"应用打不开"。
 *
 * 本文件不 import 任何窗口 / IPC 模块（纯逻辑 + 文件操作），也不做任何 UI 反馈。
 */

/** 本次检查通过后待装的更新；`applyUpdate` 取走即清空 */
type PendingUpdate =
  | { source: 'repo'; version: string; manifest: RepoManifest }
  | { source: 'release'; version: string; url: string }

let pending: PendingUpdate | null = null

/**
 * 尝试标记的落点。**故意写成函数而不是模块级常量**：`app.getPath()` 在模块加载期还不能调
 * （单实例锁之前、测试环境里 app 是 mock 甚至不存在），写在常量里会让任何 import 到本文件的
 * 模块在加载时就炸——registry 一行带动半个测试集。
 */
function stateFile(): string {
  return join(app.getPath('userData'), 'update-state.json')
}

/**
 * 版本比较：按 `.` 分段逐段比数字，段数不同按缺省 0（`0.60` 与 `0.60.0` 相等）。
 * 任一段不是有限数字按 0 处理（不抛异常——版本号是外部文件里来的，不能让它把启动搞崩）。
 */
export function compareVersion(a: string, b: string): number {
  const left = segmentsOf(a)
  const right = segmentsOf(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

function segmentsOf(version: string): number[] {
  return version.split('.').map(part => {
    const value = Number(part.trim())
    return Number.isFinite(value) ? value : 0
  })
}

/* ------------------------------------------------------------------ *
 * 防重启循环的标记
 * ------------------------------------------------------------------ */

/** 标记有效期（v0.83）：过期后允许重试，避免「标记写了但载荷没装」把某版本永久挡死 */
const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 落盘格式：`{ "version": "0.79.0", "at": "2026-11-06T…" }`（v0.83 起）。
 * 旧文件是 `{ "attemptedVersion": "0.79.0" }`，`at` 缺失即视为已过期——所以老用户
 * 升级到本版后，上一次失败的版本会被放行重试一次。
 */
interface AttemptMark {
  version: string
  at: string | null
}

function readState(): AttemptMark | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const raw = parsed as { attemptedVersion?: unknown; version?: unknown; at?: unknown }
    // 旧格式：纯字符串，没有时间戳
    if (typeof raw.attemptedVersion === 'string') {
      return { version: raw.attemptedVersion, at: null }
    }
    if (typeof raw.version !== 'string') return null
    return { version: raw.version, at: typeof raw.at === 'string' ? raw.at : null }
  } catch {
    return null
  }
}

function writeState(mark: AttemptMark | null): void {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true })
  const body = mark === null ? {} : { version: mark.version, at: mark.at }
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

/** 标记是否还在有效期内（`at === null` 一律算过期，允许重试） */
function markIsFresh(mark: AttemptMark, latest: string): boolean {
  if (mark.version !== latest) return false
  if (mark.at === null) return false
  const triedAt = Date.parse(mark.at)
  if (Number.isNaN(triedAt)) return false
  return Date.now() - triedAt < ATTEMPT_TTL_MS
}

/* ------------------------------------------------------------------ *
 * 检查
 * ------------------------------------------------------------------ */

export interface CheckOptions {
  /** 人工触发（设置页按钮）：跳过 `attemptedVersion` 拦截，仍然写标记 */
  manual?: boolean
}

/**
 * 查一次有没有新版本（仓库直拉优先，失败才回退 GitHub Release）。
 *
 * `applying` 只在**这次真的要装**时为真，判定顺序不能反：
 * 1. 连不上 GitHub → 自动路径静默返回（不弹窗、不挡启动），人工路径抛错给设置页显示；
 * 2. 没更新 → 什么标记都不碰；
 * 3. 有新版本但**这个版本已经尝试过**（覆盖失败，版本号没变）→ 不再试，避免无限重启。
 *    这条只拦**自动**路径：它是防重启死循环的，不该同时变成"禁止人工再试一次"。
 * 4. 否则先写标记再放行——写完才装，进程随时会在 `applyUpdate` 里退出，写晚了标记就丢。
 *
 * `manual` 只跳过第 3 条的拦截，**不跳过写标记**：人工点一次失败后，自动路径同样不会再自动重试。
 * 安装成功后 `getVersion()` 自然等于新版本，规则 2 生效，标记失去作用，不必在成功时清。
 */
export async function checkUpdate(options: CheckOptions = {}): Promise<CheckResult> {
  const current = app.getVersion()
  let found: PendingUpdate
  try {
    const manifest = await fetchRepoManifest()
    found = { source: 'repo', version: manifest.version, manifest }
  } catch (repoError) {
    console.warn('[update] 仓库源不可用，回退 Release', repoError)
    try {
      const release = await fetchLatestRelease()
      found = { source: 'release', version: release.version, url: release.payloadUrl }
    } catch (e) {
      // 抛 AppErrorException 而不是普通 Error：IPC 信封把普通 Error 收口成 UNKNOWN「未知错误」，
      // 设置页 flashUpdateNote(res.error.message) 就看不到这句提示了（envelope.ts:16-21 / useSettingsData.ts:180）。
      if (options.manual === true) {
        // 78b：按 github.ts 的 failure 标记分档——404（没发过 Release）与网络/TLS 失败
        // 在界面上要能区分，否则「仓库还没有版本」会被误读成「连不上 GitHub」
        const failure = (e as { failure?: string }).failure
        const message =
          failure === 'notfound'
            ? '检查更新失败：仓库还没有发布任何版本'
            : failure === 'network'
              ? '检查更新失败：连不上 GitHub'
              : '检查更新失败：无法访问 GitHub'
        throw appError('UNKNOWN', message, {
          detail: e instanceof Error ? e.message : String(e)
        })
      }
      console.error('[update] 查询 GitHub 失败', e)
      return { current, latest: null, hasUpdate: false, applying: false }
    }
  }

  const latest = found.version
  const hasUpdate = compareVersion(latest, current) > 0
  if (!hasUpdate) return { current, latest, hasUpdate: false, applying: false }

  if (options.manual !== true) {
    const mark = readState()
    if (mark !== null && markIsFresh(mark, latest)) {
      console.error(`[update] ${latest} 上次已尝试过但版本未变，本次不再安装`)
      return { current, latest, hasUpdate: true, applying: false }
    }
    if (mark !== null && mark.version === latest) {
      console.warn(`[update] ${latest} 的尝试标记已超 24 小时，允许重试`)
    }
  }

  try {
    writeState({ version: latest, at: new Date().toISOString() })
  } catch (e) {
    // 标记写不下去就不装：没有标记的自动安装 = 一旦覆盖失败就无限重启
    console.error('[update] 写 update-state.json 失败，本次不安装', e)
    return { current, latest, hasUpdate: true, applying: false }
  }
  pending = found
  return { current, latest, hasUpdate: true, applying: true }
}

/* ------------------------------------------------------------------ *
 * 安装（进程内覆盖 + relaunch）
 * ------------------------------------------------------------------ */

/** 读某个 `package.json` 的 `version`；读不到 / 不是对象 / 不是字符串 → `null` */
function versionOf(pkgFile: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgFile, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * 递归拷贝，覆盖同名文件。手写而不用 `fs.cpSync`：本机这套环境下 `cpSync` 会静默杀掉进程。
 * 只用于 staging → `resources/app`（`out/` 与 `package.json`），不碰 `node_modules`。
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else copyFileSync(src, dst)
  }
}

/** 暂存目录清理失败也只记日志，不能让一次网络抖动卡住后续更新 */
function clearStaging(staging: string): void {
  try {
    rmSync(staging, { recursive: true, force: true })
  } catch (e) {
    console.error('[update] 清暂存目录失败', e)
  }
}

/**
 * 覆盖后必须存在的关键资源（v0.83）。路径对齐 `out/` 的实际产物形态，
 * 与 `scripts/make-payload.mjs` 的自检清单保持同一份。
 *
 * 只校验 `package.json` 版本是不够的：载荷里只放一个正确的 package.json、
 * 不带 `out/`，版本校验照样通过——装完重启就是白屏，而且版本号已变、
 * 自动路径再也不会重装。
 */
const CRITICAL_IN_OUT = [
  'main/index.js',
  'preload/index.js',
  'renderer/main/index.html',
  'renderer/hud/index.html',
  'renderer/notify/index.html'
] as const

/** 相对 `resources/app` 的清单（覆盖后校验用） */
export const REQUIRED_FILES: readonly string[] = CRITICAL_IN_OUT.map(rel => `out/${rel}`)

/**
 * 返回缺失或为空的关键文件清单；空数组 = 通过。
 * `root` 是 `resources/app` 时用默认清单；是 `out`（或 `out.bak`）时传 `CRITICAL_IN_OUT`。
 */
function missingCritical(root: string, entries: readonly string[] = REQUIRED_FILES): string[] {
  const bad: string[] = []
  for (const rel of entries) {
    try {
      const stat = statSync(join(root, rel))
      if (!stat.isFile() || stat.size === 0) bad.push(rel)
    } catch {
      bad.push(rel)
    }
  }
  return bad
}

/**
 * 现在装在 `resources/app` 里的这套东西还能不能用（v0.83b）。
 *
 * `true` 当且仅当「关键资源齐全且非空」**且**「package.json 的版本正是预期的旧版」。
 *
 * 存在的理由：`rollbackInstall` 第一步是「备份不可读就一个目录都不动」，而最常见的
 * 回滚失败恰好是「备份没了、旧版还在」——覆盖时先 `rmSync(outBak)` 再 `renameSync(outDir, outBak)`，
 * 那一步改名失败时 `out` 仍是完好的旧版本、`out.bak` 已不存在，于是 `rollbackInstall` 返回
 * `false`。不自己看一眼就判「双失败」会把完好的旧版也一起赔进去（窗口全销毁、进程留在后台）。
 *
 * 导出仅为单测能直接钉它（同 `REQUIRED_FILES`）。
 */
export function isInstallIntact(resourcesApp: string, version: string): boolean {
  if (missingCritical(resourcesApp).length > 0) return false
  return versionOf(join(resourcesApp, 'package.json')) === version
}

/**
 * 回滚（v0.83），三步固定顺序：
 * 1. 先确认备份存在且关键资源可读，摸不到就一个目录都不动
 * 2. 新 `out` 改名 `out.failed`（不删，留着查），`out.bak` 改名回来
 * 3. 校验恢复后的关键资源，通过才算成功
 *
 * 返回 `true` 表示旧版已可用；`false` 表示备份本身也不可用。
 */
function rollbackInstall(resourcesApp: string): boolean {
  const outDir = join(resourcesApp, 'out')
  const outBak = join(resourcesApp, 'out.bak')
  const outFailed = join(resourcesApp, 'out.failed')
  const pkg = join(resourcesApp, 'package.json')
  const pkgBak = join(resourcesApp, 'package.json.bak')

  // 1. 备份不可读 → 不动任何目录，保留现场
  if (!existsSync(outBak) || missingCritical(outBak, CRITICAL_IN_OUT).length > 0) {
    console.error('[update] 回滚中止：out.bak 不可用，未改任何目录')
    return false
  }
  if (!existsSync(pkgBak)) {
    console.error('[update] 回滚中止：package.json.bak 不可用，未改任何目录')
    return false
  }

  try {
    // 2. 新的坏 out 先改名保住（不 rmSync），再把备份改回来
    if (existsSync(outFailed)) rmSync(outFailed, { recursive: true, force: true })
    if (existsSync(outDir)) renameSync(outDir, outFailed)
    renameSync(outBak, outDir)
    copyFileSync(pkgBak, pkg)
  } catch (e) {
    console.error('[update] 回滚改名/复制失败', e)
    return false
  }

  // 3. 恢复出来的旧版也必须自检
  if (missingCritical(outDir, CRITICAL_IN_OUT).length > 0) {
    console.error('[update] 回滚后关键资源仍不可读，恢复原状')
    try {
      if (existsSync(outDir)) renameSync(outDir, outBak)
      if (existsSync(outFailed)) renameSync(outFailed, outDir)
    } catch (e) {
      console.error('[update] 恢复原状失败', e)
    }
    return false
  }
  return true
}

/** 没走到重启就清标记：下一次启动还能再试这一版 */
function resetAttempted(): void {
  try {
    writeState(null)
  } catch (e) {
    console.error('[update] 清尝试标记失败', e)
  }
}

/**
 * 覆盖 `resources/app` 并重启（v0.83 起分三种结局）。
 *
 * 顺序：载荷解到 staging → `destroy` 窗口释放 `out/renderer/**` 文件锁 → `out` 改名 `out.bak`、
 * `package.json` 拷一份 `.bak` → `copyTree` → 校验版本号与关键资源 → 不过就回滚。
 *
 * 三种结局：
 * 1. 覆盖成功 → relaunch → quit
 * 2. 覆盖失败、回滚成功（或回滚没做成但旧版本身完好）→ relaunch → quit
 * 3. 覆盖失败、回滚也失败且旧版不可用 → **不 relaunch、不 quit**，保留 out.failed / out.bak 供人工恢复
 *
 * `destroy` 仍在覆盖之前：窗口占着 `out/renderer/**`，不销毁拷贝必失败。它会触发
 * `window-all-closed` → `app.quit()`，所以用 `before-quit` 闸门卡住退出，等结论出来再放行。
 * `relaunch` 全程只调一次（多次会拉起多个实例）。
 *
 * 为什么不直接往 `out` 上覆盖：会留下上一版 hash 资源，新旧混在一个目录里；先改名再拷贝得到干净目录，
 * 回滚也只需改名回来（改名不占空间、不耗时）。
 */
export async function applyUpdate(): Promise<void> {
  if (pending === null) return
  const update = pending
  const { version } = update
  pending = null

  // 任何文件操作之前取一次运行中程序的版本：覆盖会把新的 package.json 拷进去，
  // 之后再读就已经是「新版」了，判旧版是否完好会失去基准。
  const currentVersion = app.getVersion()

  const staging = join(app.getPath('userData'), 'update-staging')
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    if (update.source === 'repo') {
      // raw 的 CDN 缓存约 5 分钟，会出现「清单新、文件旧」的半新半旧：由
      // downloadRepoTree 末尾的 package.json 版本校验挡住。失败就是「这次不更新」，
      // 下面的 catch 清 staging + 重置尝试标记，下次启动自动重试。
      if (await downloadRepoTree(update.manifest, staging) === 0) {
        throw new Error('仓库源没有可写入的文件')
      }
    } else {
      const payload = parsePayload(await downloadPayload(update.url))
      if (payload.version !== version) {
        console.error(`[update] 载荷版本 ${payload.version} 与 Release ${version} 不一致`)
        clearStaging(staging)
        resetAttempted()
        return
      }
      if (writePayloadTree(payload, staging) === 0) {
        throw new Error('载荷里没有可写入的文件')
      }
    }
  } catch (e) {
    console.error('[update] 下载或解包失败', e)
    clearStaging(staging)
    resetAttempted()
    return
  }

  // 用 `app.getPath('exe')` 而不是 `process.execPath`：两者在真机上是同一个路径，
  // 但前者可以被单测注入（覆盖/回滚这条路必须能在测试里跑真实文件操作）。
  const resourcesApp = join(dirname(app.getPath('exe')), 'resources', 'app')
  const source = staging
  const outDir = join(resourcesApp, 'out')
  const outBak = join(resourcesApp, 'out.bak')
  const pkg = join(resourcesApp, 'package.json')
  const pkgBak = join(resourcesApp, 'package.json.bak')

  // 覆盖期间窗口会被 destroy，`window-all-closed` 会立刻调 app.quit()。
  // 先挂一个「未放行就不许退」的闸，否则进程会在拷贝完成前就被带走。
  let allowQuit = false
  const holdQuit = (event: { preventDefault: () => void }): void => {
    if (!allowQuit) event.preventDefault()
  }
  app.on('before-quit', holdQuit)

  let covered = false
  try {
    // 用 destroy 不用 close：close 会被各窗口 close 事件里的拦截逻辑挡下，
    // 窗口留着就还占着 out/renderer/**，拷贝必失败
    for (const win of BrowserWindow.getAllWindows()) win.destroy()

    if (existsSync(outBak)) rmSync(outBak, { recursive: true, force: true })
    if (existsSync(outDir)) renameSync(outDir, outBak)
    if (existsSync(pkg)) copyFileSync(pkg, pkgBak)

    copyTree(source, resourcesApp)

    // 版本号与关键资源是「与」的关系：任一不过都算覆盖失败
    const landed = versionOf(pkg)
    const missing = missingCritical(resourcesApp)
    if (landed !== version) {
      console.error(`[update] 覆盖后版本不是 ${version}（实得 ${landed ?? 'null'}），回滚`)
    } else if (missing.length > 0) {
      console.error(`[update] 覆盖后关键资源缺失：${missing.join('、')}，回滚`)
    } else {
      covered = true
    }
  } catch (e) {
    console.error('[update] 覆盖失败，回滚', e)
  }

  const rolledBack = covered ? false : rollbackInstall(resourcesApp)
  // 只在「覆盖失败且回滚也没做成」时才需要多扫一次目录：回滚没做成、但旧版本身完好
  // （备份丢了、out 从未被换掉），那就不该按双失败处理。
  const intact = covered || rolledBack ? false : isInstallIntact(resourcesApp, currentVersion)

  // 覆盖失败、回滚失败、旧版也不可用：此刻 out 一定不可用，重启只会白屏。
  // 保留 out.failed / out.bak 供人工恢复，本进程不退出、不重启。
  if (!covered && !rolledBack && !intact) {
    app.off('before-quit', holdQuit)
    console.error('[update] 回滚失败，保留 out.failed / out.bak 供人工恢复；本次不重启')
    return
  }

  if (intact) {
    console.warn(
      `[update] 回滚未完成，但旧版仍完好（关键资源齐全、版本 ${currentVersion}），按回滚成功处理`
    )
  }

  // 覆盖成功、或覆盖失败但旧版已恢复：两种都可以安全重启
  app.off('before-quit', holdQuit)
  app.relaunch()
  allowQuit = true
  app.quit()
}

/* ------------------------------------------------------------------ *
 * 启动钩子
 * ------------------------------------------------------------------ */

/**
 * 启动自检（60 §3）：开发模式不跑；`applying` 为真才装。**失败一律静默**（只进主进程日志）。
 */
export async function runStartupUpdateCheck(): Promise<void> {
  if (!app.isPackaged) return
  try {
    const result = await checkUpdate()
    if (result.applying) void applyUpdate()
  } catch (e) {
    console.error('[update] 启动自检失败', e)
  }
}
