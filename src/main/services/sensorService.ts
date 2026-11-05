import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { get } from 'node:http'
import { dirname, join } from 'node:path'
import type { SensorReading } from '@shared/types/ipc'

/**
 * 悬浮条温度（v0.62）：CPU 走 LibreHardwareMonitor 的 Web 服务，GPU 优先同源、失败再问 nvidia-smi。
 *
 * 纪律：
 * - **不 import electron 于模块顶层**：`shell` 只在 `ensureLhmStarted()` 里动态取，
 *   本文件的解析函数能直接在纯 node 测试里跑；
 * - 两路互不影响：一路拿不到只让那一路是 `null`，不抛、不拦另一路；
 * - 温度用整数摄氏度，`0.0 °C` 视为"没有值"（LHM 对读不到的传感器就给这个占位值）。
 */

export const LHM_PORT = 8085
export const LHM_URL = `http://127.0.0.1:${LHM_PORT}/data.json`
/** 缓存窗口：渲染层 2 秒问一次，1.5 秒内重复问直接给上次结果，不再打一次 HTTP */
export const CACHE_MS = 1500

/** 合法温区：下限 1（0.0 是 LHM 的"没读到"），上限 125（超过就是解析或传感器坏了） */
const MIN_TEMP = 1
const MAX_TEMP = 125
const LHM_TIMEOUT_MS = 1200
const SMI_TIMEOUT_MS = 1500

let cached: SensorReading | null = null
let cachedAt = 0
/** 同一失败原因只 warn 一次；成功一次后复位 */
let lhmWarned = false
/** 本进程生命周期内只尝试拉起一次 */
let launchAttempted = false

/** 取一段文本；非 200 / 超时 / 连不上都 reject（调用方按失败处理） */
function fetchText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(url, res => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
  })
}

/** 数字部分：LHM 的 `Value` 是 locale 格式化过的，`,` 也可能当小数点 */
const NUMBER_PATTERN = /-?\d+(?:[.,]\d+)?/

/**
 * `"62.0 °C"` / `"62,0 °C"` → 62；没有数字或超出 1..125 → null。
 * 取整用 `Math.round()`，`95.0 → 95`。
 */
export function parseTemperature(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = NUMBER_PATTERN.exec(value)
  if (match === null) return null
  const parsed = Number(match[0].replace(',', '.'))
  if (!Number.isFinite(parsed)) return null
  const rounded = Math.round(parsed)
  if (rounded < MIN_TEMP || rounded > MAX_TEMP) return null
  return rounded
}

interface LhmNode {
  Text?: unknown
  SensorId?: unknown
  Type?: unknown
  Value?: unknown
  Children?: unknown
}

/**
 * 从 LHM 的 `data.json` 里挑出两个温度（老 OHM 格式：一棵树，节点带 Text / SensorId / Value / Children）。
 *
 * 只认 `Type === 'Temperature'` 的叶子，按 **硬件前缀 + Text** 双条件命中——单看 Text 会被
 * 内存条的 `DIMM #1` 之类的温度误伤，单看 SensorId 下标换硬件就变。命中多个取第一个。
 * JSON 坏 / 结构不对一律返回两个 null，**不抛**。
 */
export function pickTemperatures(rawJson: string): { cpu: number | null; gpu: number | null } {
  let root: unknown
  try {
    root = JSON.parse(rawJson)
  } catch {
    return { cpu: null, gpu: null }
  }

  let cpu: number | null = null
  let gpu: number | null = null
  let cpuSeen = false
  let gpuSeen = false

  const walk = (node: unknown): void => {
    if (cpuSeen && gpuSeen) return
    if (node === null || typeof node !== 'object') return
    const item = node as LhmNode

    if (item.Type === 'Temperature' && typeof item.SensorId === 'string' && typeof item.Text === 'string') {
      const sensorId = item.SensorId
      if (
        !cpuSeen &&
        item.Text === 'CPU Package' &&
        (sensorId.startsWith('/intelcpu/') || sensorId.startsWith('/amdcpu/'))
      ) {
        cpuSeen = true
        cpu = parseTemperature(item.Value)
      } else if (!gpuSeen && item.Text === 'GPU Core' && sensorId.startsWith('/gpu-')) {
        gpuSeen = true
        gpu = parseTemperature(item.Value)
      }
    }

    const children = item.Children
    if (Array.isArray(children)) {
      for (const child of children) walk(child)
    }
  }

  walk(root)
  return { cpu, gpu }
}

/** GPU 备用来源（不需要管理员）；没独显是正常情况，失败不记日志 */
function readNvidiaSmi(): Promise<number | null> {
  return new Promise(resolve => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: SMI_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        // 多卡时是多行，只取第一行
        const first = stdout.split(/\r?\n/).find(line => line.trim().length > 0)
        if (first === undefined) {
          resolve(null)
          return
        }
        const parsed = Number.parseInt(first.trim(), 10)
        if (!Number.isFinite(parsed) || parsed < MIN_TEMP || parsed > MAX_TEMP) {
          resolve(null)
          return
        }
        resolve(parsed)
      }
    )
  })
}

/** 读一次；两路互不影响，哪一路失败只让那一路是 null */
export async function readSensors(): Promise<SensorReading> {
  if (cached !== null && Date.now() - cachedAt < CACHE_MS) return cached

  let cpu: number | null = null
  let gpu: number | null = null

  try {
    const picked = pickTemperatures(await fetchText(LHM_URL, LHM_TIMEOUT_MS))
    cpu = picked.cpu
    gpu = picked.gpu
    lhmWarned = false
  } catch {
    // 每 2 秒都会再问一次，这一次失败下一次自然补上：不重试、不等待，只 warn 一次
    if (!lhmWarned) {
      lhmWarned = true
      console.warn('[sensor] LibreHardwareMonitor 读数不可用，CPU 温度暂缺')
    }
  }

  if (gpu === null) gpu = await readNvidiaSmi()

  cached = { cpu, gpu, at: new Date().toISOString() }
  cachedAt = Date.now()
  return cached
}

/** 测试用：清缓存 */
export function resetCache(): void {
  cached = null
  cachedAt = 0
}

/**
 * 应用启动时调一次：LHM 没在跑就拉起它。
 *
 * - 只在打包版（`app.isPackaged`）里动作，开发模式直接返回；
 * - 先探 `LHM_PORT`，已有服务就不重复拉；
 * - exe 不存在就返回（用户没装 LHM 时不能崩）；
 * - 本进程生命周期内只尝试一次。
 *
 * 拉起用 `shell.openPath` 而不是 `spawn`：LHM 的清单是 `requireAdministrator`，
 * 只有走 ShellExecute 才会弹 UAC。
 */
export async function ensureLhmStarted(): Promise<void> {
  if (launchAttempted) return
  launchAttempted = true

  // 动态取：本文件在纯 node 测试里被直接 import，顶层不该依赖 electron
  const { app, shell } = await import('electron')
  if (!app.isPackaged) return

  const exe = join(dirname(process.execPath), 'lhm', 'LibreHardwareMonitor.exe')
  if (!existsSync(exe)) return

  try {
    await fetchText(LHM_URL, LHM_TIMEOUT_MS)
    return
  } catch {
    // 没在跑，往下拉起
  }

  try {
    const failure = await shell.openPath(exe)
    // 返回非空字符串 = 失败（用户点了 UAC「否」或别的错）：不重试、不弹窗、不影响应用
    if (failure.length > 0) console.warn('[sensor] 拉起 LibreHardwareMonitor 失败:', failure)
  } catch (e: unknown) {
    console.warn('[sensor] 拉起 LibreHardwareMonitor 失败:', e)
  }
}
