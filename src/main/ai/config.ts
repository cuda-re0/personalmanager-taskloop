import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'

/**
 * API Key 的读取与写入（03 §9.7 的三级优先级）。
 *
 * ```
 * 1. safeStorage 加密文件（userData/ai-key.bin）—— 打包版唯一来源
 * 2. process.env.ZHIPU_API_KEY —— 开发期来源
 * 3. !app.isPackaged 时额外读仓库根的 .env.local
 * 4. 都没有 → null（调用方返回 AI_NOT_CONFIGURED，不抛到这里）
 * ```
 *
 * 三条纪律：
 * - **任何日志、异常 detail 里都不许出现 key**，连前 6 位都不许（03 §9.7 末句）。
 *   本文件唯一的 console 输出是一条不含 key 的降级警告。
 * - `writeKey()` 自身不注册通道：v0.47 起统一由 `ai.setKey` 经 `aiService.setKey` 调用（04 §10）。
 * - electron 的 `app` / `safeStorage` 在本项目测试宿主（`ELECTRON_RUN_AS_NODE`）下是
 *   `undefined` 或字符串路径，所以每一处用法都要先判类型——模块顶层不许碰，
 *   否则所有 import 到这里的测试文件都会在 import 阶段炸掉。
 */

const ENV_NAME = 'ZHIPU_API_KEY'
const KEY_FILE = 'ai-key.bin'
/** .env.local 只解析 `KEY=VALUE`，不引新依赖（开工词 §4.3） */
const ENV_LOCAL_FILE = '.env.local'

let warned = false

function hasApp(): boolean {
  return typeof app === 'object' && app !== null && typeof app.getPath === 'function'
}

function userDataDir(): string | null {
  if (!hasApp()) return null
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

function encryptionAvailable(): boolean {
  if (typeof safeStorage !== 'object' || safeStorage === null) return false
  try {
    return safeStorage.isEncryptionAvailable() === true
  } catch {
    // Linux 上无 keyring 时会抛，语义等同"不可用"
    return false
  }
}

/** 只在"本该能加密却加密不了"时说一次，且不带 key、不带路径细节 */
function warnOnce(message: string): void {
  if (warned) return
  warned = true
  console.warn(`[ai/config] ${message}`)
}

function readEncryptedKey(): string | null {
  const dir = userDataDir()
  if (dir === null) return null
  const file = join(dir, KEY_FILE)
  if (!existsSync(file)) return null
  if (!encryptionAvailable()) {
    warnOnce('safeStorage 不可用，跳过加密文件，降级到环境变量')
    return null
  }
  try {
    const plain = safeStorage.decryptString(readFileSync(file))
    const trimmed = plain.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (e) {
    // 解密失败通常是换了机器/换了 OS 账号：不回退成乱码，也不打内容
    warnOnce(`加密文件无法解密，已忽略（${e instanceof Error ? e.name : 'unknown'}）`)
    return null
  }
}

function readDevEnvFile(): string | null {
  // 打包产物绝不读 .env.local（03 §9.7）
  if (!hasApp()) return null
  if (app.isPackaged !== false) return null

  let root: string
  try {
    root = app.getAppPath()
  } catch {
    return null
  }
  const file = join(root, ENV_LOCAL_FILE)
  if (!existsSync(file)) return null

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    if (line.slice(0, eq).trim() !== ENV_NAME) continue
    return unquote(line.slice(eq + 1).trim()) || null
  }
  return null
}

/** 允许 `KEY="value"` / `KEY='value'` 两种写法（.env 的常见形态） */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim()
    }
  }
  return value
}

/**
 * 读 Key：加密文件 → 环境变量 → `.env.local`（仅开发期）。都没有返回 null。
 * **不抛异常**：没配 Key 是正常状态，由 `ai.health` 的 `configured:false` 表达。
 */
export function readKey(): string | null {
  const encrypted = readEncryptedKey()
  if (encrypted !== null) return encrypted

  const fromEnv = (process.env[ENV_NAME] ?? '').trim()
  if (fromEnv.length > 0) return fromEnv

  return readDevEnvFile()
}

/**
 * 写 Key（`userData/ai-key.bin`，safeStorage 加密）。
 *
 * v0.47 起由 `ai.setKey` 调用（经 `aiService.setKey` 转一手）。本文件仍不直接注册通道。
 * 加密不可用时**不落明文**——写一个明文 key 文件
 * 比没有这个功能更糟，因此只警告一次并跳过（返回 false 让调用方知道没写成功）。
 */
export function writeKey(key: string): boolean {
  const trimmed = key.trim()
  if (trimmed.length === 0) return false
  const dir = userDataDir()
  if (dir === null) {
    warnOnce('没有可用的 userData 目录，Key 未写入')
    return false
  }
  if (!encryptionAvailable()) {
    warnOnce('safeStorage 不可用，拒绝写入明文 Key')
    return false
  }
  const file = join(dir, KEY_FILE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, safeStorage.encryptString(trimmed), { mode: 0o600 })
  return true
}
