import { app, BrowserWindow } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { CheckResult } from '../../shared/types/ipc'

/**
 * 本机绿色版自更新（v0.60）。**只认 exe 同级的 `updates/` 目录，不联网、不校验签名、不算 sha256。**
 *
 * 形态写死（60 §0）：
 * - `updates/latest.json`：`{"version":"x.y.z"}`，只有版本号一个字段；
 * - `updates/app/`：新版本的 `out/` + `package.json`，即覆盖 `resources/app/` 的替换源；
 * - 起 8 秒后检查一次 → 版本更新则销毁窗口、**在进程内覆盖**、`relaunch` 拉起。
 *
 * v0.60b：覆盖不再交给退出后跑的 `apply.cmd`（含中文的安装路径下 bat 会被 cmd 按 ANSI 解析而全盘落空，
 * 失败模式是"退出后不再回来"）。改由主进程自己用 Node `fs` 拷，Unicode 路径没有代码页问题，
 * 失败就回滚并照常启动——最坏结果是"这次没更新"，不是"应用打不开"。
 *
 * 本文件不 import 任何窗口 / IPC 模块（纯逻辑 + 文件操作），也不做任何 UI 反馈。
 */

const UPDATE_DIR = join(dirname(process.execPath), 'updates') // exe 同级

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

/**
 * 读 `latest.json`。文件不存在 / 不是合法 JSON / `version` 不是非空字符串 → `null`。
 * **任何异常都吞掉**：更新检查永远不能让应用启动失败。
 */
export function readManifest(dir: string = UPDATE_DIR): { version: string } | null {
  try {
    const raw = readFileSync(join(dir, 'latest.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const version = (parsed as { version?: unknown }).version
    if (typeof version !== 'string' || version.trim().length === 0) return null
    return { version: version.trim() }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 防重启循环的标记
 * ------------------------------------------------------------------ */

interface UpdateState {
  attemptedVersion: string | null
}

function readState(): UpdateState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { attemptedVersion: null }
    const attempted = (parsed as { attemptedVersion?: unknown }).attemptedVersion
    return { attemptedVersion: typeof attempted === 'string' ? attempted : null }
  } catch {
    return { attemptedVersion: null }
  }
}

function writeState(state: UpdateState): void {
  const file = stateFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/* ------------------------------------------------------------------ *
 * 检查
 * ------------------------------------------------------------------ */

export interface CheckOptions {
  /** 人工触发（设置页按钮）：跳过 `attemptedVersion` 拦截，仍然写标记 */
  manual?: boolean
}

/**
 * 查一次有没有新版本。
 *
 * `applying` 只在**这次真的要装**时为真，并且判定顺序不能反：
 * 1. 没更新 → 什么标记都不碰；
 * 2. 有新版本但**这个版本已经尝试过**（覆盖失败，版本号没变）→ 不再试，避免无限重启。
 *    这条只拦**自动**路径：它是防重启死循环的，不该同时变成"禁止人工再试一次"。
 * 3. 否则先写标记再放行——写完才装，进程随时会在 `applyUpdate` 里退出，写晚了标记就丢。
 *
 * `manual` 只跳过第 2 条的拦截，**不跳过写标记**：人工点一次失败后，自动路径同样不会再自动重试。
 * 安装成功后 `getVersion()` 自然等于新版本，规则 1 生效，标记失去作用，不必在成功时清。
 */
export async function checkUpdate(options: CheckOptions = {}): Promise<CheckResult> {
  const current = app.getVersion()
  const manifest = readManifest()
  if (manifest === null) return { current, latest: null, hasUpdate: false, applying: false }

  const latest = manifest.version
  const hasUpdate = compareVersion(latest, current) > 0
  if (!hasUpdate) return { current, latest, hasUpdate: false, applying: false }

  if (options.manual !== true && readState().attemptedVersion === latest) {
    console.error(`[update] ${latest} 上次已尝试过但版本未变，本次不再安装`)
    return { current, latest, hasUpdate: true, applying: false }
  }

  try {
    writeState({ attemptedVersion: latest })
  } catch (e) {
    // 标记写不下去就不装：没有标记的自动安装 = 一旦覆盖失败就无限重启
    console.error('[update] 写 update-state.json 失败，本次不安装', e)
    return { current, latest, hasUpdate: true, applying: false }
  }
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
 * 只用于 `updates/app` → `resources/app`（`out/` 与 `package.json`），不碰 `node_modules`。
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

/**
 * 覆盖 `resources/app` 并重启。
 *
 * 顺序（60b §2.2）：再读一次 manifest → **先 `relaunch`** → `destroy` 窗口 → `out` 改名成 `out.bak`、
 * `package.json` 拷一份 `.bak` → `copyTree` → 校验覆盖后的版本号 → 不等或抛异常就回滚 →
 * 无论成败最后只 `quit` 一次。
 *
 * `relaunch` 必须在 `destroy` 之前就位：`src/main/index.ts` 的 `window-all-closed` 会调 `app.quit()`，
 * 窗口一销毁退出序列就开始跑，等拷完再 relaunch 就已经晚了。**只能调一次**——多次调用会拉起多个实例。
 *
 * 失败也要重启：窗口已经被 destroy，留着进程就是一块空白；重启载入的是旧代码，`attemptedVersion`
 * 已在 `checkUpdate` 里写过，不会被第二次自动尝试。
 *
 * 为什么不直接往 `out` 上覆盖：那会留下上一版 hash 资源，新旧混在一个目录里；先改名再拷贝得到干净目录，
 * 回滚也只需改名回来（改名不占空间、不耗时）。
 */
export function applyUpdate(): void {
  const manifest = readManifest()
  if (manifest === null) return

  const resourcesApp = join(dirname(process.execPath), 'resources', 'app')
  const source = join(UPDATE_DIR, 'app')
  const outDir = join(resourcesApp, 'out')
  const outBak = join(resourcesApp, 'out.bak')
  const pkg = join(resourcesApp, 'package.json')
  const pkgBak = join(resourcesApp, 'package.json.bak')

  // 退出序列由后面的 window-all-closed 触发，重启标志必须先放好；且只放这一次
  app.relaunch()

  // 用 destroy 不用 close：close 会被各窗口 close 事件里的拦截逻辑挡下，
  // 窗口留着就还占着 out/renderer/**，拷贝必失败
  for (const win of BrowserWindow.getAllWindows()) win.destroy()

  let ok = true
  try {
    if (existsSync(outBak)) rmSync(outBak, { recursive: true, force: true })
    if (existsSync(outDir)) renameSync(outDir, outBak)
    if (existsSync(pkg)) copyFileSync(pkg, pkgBak)

    copyTree(source, resourcesApp)

    const landed = versionOf(pkg)
    if (landed !== manifest.version) {
      ok = false
      console.error(`[update] 覆盖后版本不是 ${manifest.version}（实得 ${landed ?? 'null'}），回滚`)
    }
  } catch (e) {
    ok = false
    console.error('[update] 覆盖失败，回滚', e)
  }

  if (!ok) {
    try {
      if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
      if (existsSync(outBak)) renameSync(outBak, outDir)
      if (existsSync(pkgBak)) copyFileSync(pkgBak, pkg)
    } catch (e) {
      // 回滚本身失败也只记日志：此时再把异常抛出去，进程会停在一块空白上
      console.error('[update] 回滚失败', e)
    }
  }

  // 成功也保留 out.bak：留一份最后一次可手工恢复的副本（目录改名得来的，不占额外空间）
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
    if (result.applying) applyUpdate()
  } catch (e) {
    console.error('[update] 启动自检失败', e)
  }
}
