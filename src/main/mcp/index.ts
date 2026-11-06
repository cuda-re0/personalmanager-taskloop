import { startMcpServer } from './server'
import { readOrCreateToken } from './token'

/** 本机 MCP 固定端口（77 单） */
export const MCP_PORT = 17321

let closeServer: (() => Promise<void>) | null = null

export async function startMcp(): Promise<void> {
  const token = readOrCreateToken()
  if (token === null) {
    console.warn('[mcp] 读取 token 失败，服务未启动')
    return
  }
  const running = await startMcpServer(MCP_PORT)
  closeServer = running.close
}

export async function stopMcp(): Promise<void> {
  const close = closeServer
  closeServer = null
  if (close !== null) await close()
}
