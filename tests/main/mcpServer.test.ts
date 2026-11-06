import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** 不碰 electron / 不落盘：token 用假值（77 单 C1） */
vi.mock('../../src/main/mcp/token', () => ({
  readOrCreateToken: () => 'test-token'
}))

import { startMcpServer } from '../../src/main/mcp/server'

const TOKEN = 'test-token'
let port = 0
let closeServer: () => Promise<void> = () => Promise.resolve()

beforeAll(async () => {
  const running = await startMcpServer(0)
  port = running.port
  closeServer = running.close
})

afterAll(async () => {
  await closeServer()
})

function post(body: string, extra: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...extra
    },
    body
  })
}

function rpc(method: string) {
  return post(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))
}

describe('本机 MCP HTTP transport', () => {
  it('无 token → 401', async () => {
    const res = await post('{}', { Authorization: '' })
    expect(res.status).toBe(401)
  })

  it('initialize 返回协议版本与 serverInfo', async () => {
    const res = await rpc('initialize')
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } }
    }
    expect(body.result.protocolVersion).toBeTruthy()
    expect(body.result.serverInfo.name).toBe('taskloop')
  })

  it('tools/list 返回 6 个工具，名字齐全', async () => {
    const res = await rpc('tools/list')
    const body = (await res.json()) as { result: { tools: { name: string }[] } }
    expect(body.result.tools).toHaveLength(6)
    expect(body.result.tools.map(tool => tool.name)).toEqual([
      'get_overview',
      'list_tasks',
      'get_task',
      'list_messages',
      'get_points',
      'list_alerts'
    ])
  })

  it('未知方法 → -32601', async () => {
    const res = await rpc('no/such/method')
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32601)
  })

  it('坏 JSON → -32700', async () => {
    const res = await post('{oops')
    const body = (await res.json()) as { error: { code: number } }
    expect(body.error.code).toBe(-32700)
  })
})
