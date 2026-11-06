import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 本机 MCP 的 Bearer token（77 单）。
 *
 * 落盘后一直复用：外部 AI 的配置只写一次，不能每次启动都换一串。
 * 文件内容不进打包产物、不进任何配置、不写日志。
 */
export function readOrCreateToken(): string | null {
  try {
    const file = join(app.getPath('userData'), 'mcp-token.txt')
    try {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length > 0) return existing
    } catch {
      // 文件不存在或读不到：走下面的首次生成
    }
    const token = randomBytes(16).toString('hex')
    writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
    return token
  } catch {
    return null
  }
}
