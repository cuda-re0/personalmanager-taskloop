import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import pkg from '../../../package.json'
import { readOrCreateToken } from './token'
import { MCP_TOOLS, callTool } from './tools'

/**
 * 77 单 · 本机 MCP 的 HTTP transport（无状态，只监听回环地址）。
 *
 * 不引第三方 SDK：只用 node:http 做 JSON-RPC 2.0 分发。
 * 不实现 session、不做 SSE、不主动推送。
 */

const PROTOCOL_VERSION = '2025-06-18'

interface RpcRequest {
  id?: unknown
  method?: unknown
  params?: unknown
}

interface RpcError {
  code: number
  message: string
}

export interface RunningMcpServer {
  port: number
  close: () => Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function resultOf(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function errorOf(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error }
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function paramsOf(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return {}
  return params as Record<string, unknown>
}

function toolArgs(params: unknown): Record<string, unknown> {
  const raw = paramsOf(params).arguments
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

function toolName(params: unknown): string {
  const raw = paramsOf(params).name
  return typeof raw === 'string' ? raw : ''
}

/** 工具抛错只把一句中文消息给外部，不漏堆栈与内部路径 */
function oneLineError(e: unknown): string {
  const message = e instanceof Error ? e.message : '工具执行失败'
  return message.split('\n')[0] || '工具执行失败'
}

async function handle(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
    res.writeHead(404)
    res.end()
    return
  }
  if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
    sendJson(res, 401, {})
    return
  }
  if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, {})
    return
  }

  let request: RpcRequest | null
  try {
    request = JSON.parse(await bodyOf(req)) as RpcRequest | null
  } catch {
    sendJson(res, 200, errorOf(null, { code: -32700, message: '请求体不是合法 JSON' }))
    return
  }

  const id = request?.id ?? null
  const params = request?.params

  switch (request?.method) {
    case 'initialize':
      sendJson(
        res,
        200,
        resultOf(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'taskloop', version: pkg.version }
        })
      )
      return
    case 'notifications/initialized':
      res.writeHead(202)
      res.end()
      return
    case 'tools/list':
      sendJson(res, 200, resultOf(id, { tools: MCP_TOOLS }))
      return
    case 'tools/call': {
      let result: Record<string, unknown>
      try {
        result = {
          content: [{ type: 'text', text: JSON.stringify(callTool(toolName(params), toolArgs(params))) }]
        }
      } catch (e) {
        result = { content: [{ type: 'text', text: oneLineError(e) }], isError: true }
      }
      sendJson(res, 200, resultOf(id, result))
      return
    }
    case 'ping':
      sendJson(res, 200, resultOf(id, {}))
      return
    default:
      sendJson(res, 200, errorOf(id, { code: -32601, message: '方法不存在' }))
  }
}

export function startMcpServer(port: number): Promise<RunningMcpServer> {
  return new Promise<RunningMcpServer>(resolve => {
    const noop: RunningMcpServer = { port, close: () => Promise.resolve() }
    const token = readOrCreateToken()
    if (token === null) {
      console.warn('[mcp] 读取 token 失败，服务未启动')
      resolve(noop)
      return
    }

    const server = createServer((req, res) => {
      void handle(token, req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, {})
        else res.end()
      })
    })

    let settled = false
    let closed = false

    server.once('error', (err: Error) => {
      if (settled) return
      settled = true
      console.warn(`[mcp] 端口 ${port} 被占用，服务未启动：${err.message}`)
      resolve(noop)
    })

    server.listen(port, '127.0.0.1', () => {
      if (settled) return
      settled = true
      const address = server.address()
      const actualPort = address !== null && typeof address === 'object' ? address.port : port
      resolve({
        port: actualPort,
        close: async () => {
          if (closed) return
          closed = true
          server.closeAllConnections?.()
          await new Promise<void>((done, fail) => {
            server.close(err => (err ? fail(err) : done()))
          })
        }
      })
    })
  })
}
