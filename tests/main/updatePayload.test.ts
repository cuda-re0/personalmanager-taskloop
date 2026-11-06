import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePayload, writePayloadTree } from '../../src/main/update/payload'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const packOf = (version: string, files: Record<string, string>): string =>
  JSON.stringify({ version, files })

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'taskloop-payload-78-'))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('parsePayload（78 单）', () => {
  it('合法包解析出 version 与 files', () => {
    const payload = parsePayload(packOf('0.75.0', { 'out/main/index.js': b64('hello') }))
    expect(payload.version).toBe('0.75.0')
    expect(payload.files['out/main/index.js']).toBe(b64('hello'))
  })

  it('键含 ../evil → throw', () => {
    expect(() => parsePayload(packOf('0.75.0', { '../evil': b64('x') }))).toThrow()
  })

  it('键是绝对路径 → throw', () => {
    expect(() => parsePayload(packOf('0.75.0', { '/etc/x': b64('x') }))).toThrow()
    expect(() => parsePayload(packOf('0.75.0', { 'C:/x': b64('x') }))).toThrow()
  })

  it('version 为空串 → throw', () => {
    expect(() => parsePayload(packOf('', { 'out/main/index.js': b64('x') }))).toThrow()
  })

  it('base64 非法（含非法字符 / 长度不对）→ throw，不静默截断（v0.83）', () => {
    expect(() => parsePayload(packOf('0.75.0', { 'out/main/index.js': 'abc$' }))).toThrow()
    expect(() => parsePayload(packOf('0.75.0', { 'out/main/index.js': 'abc' }))).toThrow()
    expect(() => parsePayload(packOf('0.75.0', { 'out/main/index.js': 'a=bc' }))).toThrow()
  })

  it('单文件超过 8 MiB → throw（v0.83）', () => {
    // 11_200_000 是 4 的倍数，解码后约 8.4 MB > 8 MiB
    const huge = 'A'.repeat(11_200_000)
    expect(() => parsePayload(packOf('0.75.0', { 'out/main/index.js': huge }))).toThrow('8 MiB')
  })

  it('文件数超过 200 → throw（v0.83）', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 201; i += 1) files[`out/f${i}.js`] = b64('x')
    expect(() => parsePayload(packOf('0.75.0', files))).toThrow('200')
  })
})

describe('writePayloadTree', () => {
  it('落盘内容等于 base64 解码结果，越界键不落盘', () => {
    const escaped = join(dirname(sandbox), 'taskloop-payload-78-escape.txt')
    rmSync(escaped, { force: true })
    const payload = {
      version: '0.75.0',
      files: {
        'out/main/index.js': b64('landed'),
        '../taskloop-payload-78-escape.txt': b64('nope')
      }
    }
    try {
      expect(writePayloadTree(payload, sandbox)).toBe(1)
      expect(readFileSync(join(sandbox, 'out', 'main', 'index.js'), 'utf8')).toBe('landed')
      expect(existsSync(escaped)).toBe(false)
    } finally {
      rmSync(escaped, { force: true })
    }
  })
})
