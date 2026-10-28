import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AttachmentProtocolDeps } from '../../src/main/attachments/protocol'
import { attachmentIdFromUrl, handleAttachmentRequest } from '../../src/main/attachments/protocol'
import * as attachmentRepo from '../../src/main/db/repositories/attachmentRepo'
import * as attachmentService from '../../src/main/services/attachmentService'
import type { AttachmentEnv } from './helpers'
import { openAttachmentEnv, PNG_1X1 } from './helpers'

/**
 * 协议处理器的三条硬规则（02 §3.3b）都在这里验，不起真 Electron：
 * 路径穿越、404、Content-Type。`protocol.handle` 只负责把这里的结果包成 `Response`。
 */

const ID = 'Abcdefgh1234' // nanoid(12) 形状

interface Spies {
  lookup: string[]
  read: string[]
}

function makeDeps(
  root: string,
  rows: Record<string, { relPath: string; mime: string }>,
  opt: { readFile?: (abs: string) => Uint8Array; lookupThrows?: Error } = {}
): { deps: AttachmentProtocolDeps; spies: Spies } {
  const spies: Spies = { lookup: [], read: [] }
  return {
    spies,
    deps: {
      root: () => root,
      lookup: id => {
        spies.lookup.push(id)
        if (opt.lookupThrows) throw opt.lookupThrows
        return rows[id] ?? null
      },
      readFile: abs => {
        spies.read.push(abs)
        if (opt.readFile) return opt.readFile(abs)
        return readFileSync(abs)
      }
    }
  }
}

describe('handleAttachmentRequest · 正常路径', () => {
  let env: AttachmentEnv

  beforeEach(() => {
    env = openAttachmentEnv('taskloop-protocol')
  })

  afterEach(() => {
    env.cleanup()
  })

  it('真文件 + 真库：返回 200、Content-Type 取行里的 mime、字节与落盘一致', () => {
    // 这条同时对应验收「重启之后 app://attach/<id> 仍能取到」——
    // 处理器只认库里的 rel_path 和磁盘文件，不依赖任何内存对象
    const att = attachmentService.add({
      name: 'a.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    const res = handleAttachmentRequest(`app://attach/${att.id}`, {
      root: () => env.root,
      lookup: id => {
        const row = attachmentRepo.attachmentRowById(id)
        return row ? { relPath: row.rel_path, mime: row.mime } : null
      },
      readFile: abs => readFileSync(abs)
    })

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['content-length']).toBe(String(PNG_1X1.byteLength))
    // 02 §3.3b v0.13：非 PDF 不发 Content-Disposition（'default' 是无效 token，发了等于没写）
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(Object.keys(res.headers)).not.toContain('content-disposition')
    expect(Buffer.from(res.body as Uint8Array)).toEqual(PNG_1X1)
  })

  it('PDF 命中时 content-disposition 是 inline', () => {
    const att = attachmentService.add({
      name: 'x.pdf',
      mime: 'application/pdf',
      base64: Buffer.from('%PDF-1.7\nhi\n').toString('base64')
    })
    const res = handleAttachmentRequest(`app://attach/${att.id}`, {
      root: () => env.root,
      lookup: id => {
        const row = attachmentRepo.attachmentRowById(id)
        return row ? { relPath: row.rel_path, mime: row.mime } : null
      },
      readFile: abs => readFileSync(abs)
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe('inline')
  })
})

describe('handleAttachmentRequest · 404 与越界', () => {
  it('id 形状不对：404 且既不查库也不读文件', () => {
    const { deps, spies } = makeDeps('/tmp/whatever', {})
    for (const url of [
      'app://attach/../../../etc/passwd',
      'app://attach/..%2f..%2fetc%2fpasswd',
      'app://attach/short',
      'app://attach/',
      'app://attach/Abcdefgh12345',
      'app://attach/Abcdefgh123!'
    ]) {
      const res = handleAttachmentRequest(url, deps)
      expect(res.status).toBe(404)
    }
    expect(spies.lookup).toEqual([])
    expect(spies.read).toEqual([])
  })

  it('别的 host / 别的 scheme 一律 404', () => {
    const { deps, spies } = makeDeps('/tmp/whatever', {
      [ID]: { relPath: `2026/10/${ID}.png`, mime: 'image/png' }
    })
    expect(handleAttachmentRequest(`app://other/${ID}`, deps).status).toBe(404)
    expect(handleAttachmentRequest(`http://attach/${ID}`, deps).status).toBe(404)
    expect(handleAttachmentRequest('not a url', deps).status).toBe(404)
    expect(spies.read).toEqual([])
  })

  it('库里查不到 → 404', () => {
    const { deps } = makeDeps('/tmp/whatever', {})
    expect(handleAttachmentRequest(`app://attach/${ID}`, deps).status).toBe(404)
  })

  it('行里的 rel_path 带 .. 越界 → 404，且不去读文件', () => {
    const { deps, spies } = makeDeps('/tmp/whatever', {
      [ID]: { relPath: '../../../etc/passwd', mime: 'image/png' }
    })
    expect(handleAttachmentRequest(`app://attach/${ID}`, deps).status).toBe(404)
    expect(spies.read).toEqual([])
  })

  it('行在但文件丢了（ENOENT）→ 404', () => {
    const { deps } = makeDeps('/tmp/whatever', {
      [ID]: { relPath: `2026/10/${ID}.png`, mime: 'image/png' }
    })
    expect(handleAttachmentRequest(`app://attach/${ID}`, deps).status).toBe(404)
  })

  it('读盘失败但不是"文件不存在"（EACCES）→ 500，不是 404', () => {
    const { deps } = makeDeps(
      '/tmp/whatever',
      { [ID]: { relPath: `2026/10/${ID}.png`, mime: 'image/png' } },
      {
        readFile: () => {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
          err.code = 'EACCES'
          throw err
        }
      }
    )
    expect(handleAttachmentRequest(`app://attach/${ID}`, deps).status).toBe(500)
  })

  it('查库就炸（DB 没初始化等）→ 500', () => {
    const { deps } = makeDeps('/tmp/whatever', {}, { lookupThrows: new Error('数据库尚未初始化') })
    const res = handleAttachmentRequest(`app://attach/${ID}`, deps)
    expect(res.status).toBe(500)
    expect(Buffer.from(res.body as Uint8Array).toString('utf-8')).toContain('数据库尚未初始化')
  })
})

describe('attachmentIdFromUrl', () => {
  it('只接受 app://attach/<12 位 id>', () => {
    expect(attachmentIdFromUrl(`app://attach/${ID}`)).toBe(ID)
    expect(attachmentIdFromUrl(`app://attach/${ID}?v=2`)).toBe(ID)
    expect(attachmentIdFromUrl(`app://attach/${ID}/extra`)).toBeNull()
    expect(attachmentIdFromUrl('app://attach/../../../etc/passwd')).toBeNull()
  })
})
