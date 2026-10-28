import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Attachment } from '../../src/shared/types/domain'
import { MAX_ATTACHMENT_BYTES } from '../../src/main/attachments/constants'
import { getDb } from '../../src/main/db/connection'
import { todayLocalDay } from '../../src/main/db/localDay'
import * as attachmentRepo from '../../src/main/db/repositories/attachmentRepo'
import type { AttachmentRow } from '../../src/main/db/mappers'
import * as messageRepo from '../../src/main/db/repositories/messageRepo'
import * as attachmentService from '../../src/main/services/attachmentService'
import * as messageService from '../../src/main/services/messageService'
import { expectErrorCode } from '../db/helpers'
import type { AttachmentEnv } from './helpers'
import { filesUnder, fakePdf, openAttachmentEnv, PNG_1X1, writeTempSource } from './helpers'

let env: AttachmentEnv

beforeEach(() => {
  env = openAttachmentEnv()
})

afterEach(() => {
  env.cleanup()
})

/** add 之后把行读回来（契约类型没有 rel_path / mime，路径与 mime 断言必须走行） */
function rowOf(att: Attachment): AttachmentRow {
  const row = attachmentRepo.attachmentRowById(att.id)
  if (!row) throw new Error(`attachments 表里找不到 ${att.id}`)
  return row
}

function absOf(att: Attachment): string {
  return join(env.root, rowOf(att).rel_path)
}

describe('attachmentService.add · 落盘', () => {
  it('base64 落盘：路径形状 YYYY/MM/<id>.<ext>，扩展名由 mime 推导', () => {
    const att = attachmentService.add({
      name: '截图.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })

    expect(att.id).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(att.url).toBe(`app://attach/${att.id}`)
    expect(att.kind).toBe('image')
    expect(att.mime).toBe('image/png')
    expect(att.bytes).toBe(PNG_1X1.byteLength)
    // v1 不解析图片尺寸，按契约允许为 null（不是"忘了填"）
    expect(att.width).toBeNull()
    expect(att.height).toBeNull()

    const month = todayLocalDay().slice(0, 7).replace('-', '/')
    expect(rowOf(att).rel_path).toBe(`${month}/${att.id}.png`)
    expect(readFileSync(absOf(att))).toEqual(PNG_1X1)
  })

  it('data URL 前缀的 base64 也能收（FileReader.readAsDataURL 直接可用）', () => {
    const att = attachmentService.add({
      name: '截图.png',
      mime: 'image/png',
      base64: `data:image/png;base64,${PNG_1X1.toString('base64')}`
    })
    expect(readFileSync(absOf(att))).toEqual(PNG_1X1)
  })

  it('mime 大小写与参数不影响白名单判定，但落库的是归一化后的值', () => {
    const att = attachmentService.add({
      name: 'x.png',
      mime: 'IMAGE/PNG; charset=binary',
      base64: PNG_1X1.toString('base64')
    })
    expect(att.mime).toBe('image/png')
    expect(rowOf(att).rel_path.endsWith('.png')).toBe(true)
  })

  it('同名文件不会进路径：用户文件名只进日志', () => {
    const att = attachmentService.add({
      name: '../../../../etc/passwd.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    const rel = rowOf(att).rel_path
    expect(rel).toBe(`${todayLocalDay().slice(0, 7).replace('-', '/')}/${att.id}.png`)
    expect(rel).not.toContain('passwd')
    expect(rel).not.toContain('..')
    // 没有任何文件被写到 root 之外
    expect(filesUnder(env.root)).toEqual([rel])
    expect(existsSync(join(env.base, 'etc'))).toBe(false)
  })

  it('同内容 add 两次：两行、两个 id、rel_path 相同、磁盘只有一个文件', () => {
    const first = attachmentService.add({
      name: 'a.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    const second = attachmentService.add({
      name: 'b.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })

    expect(second.id).not.toBe(first.id)
    expect(rowOf(second).rel_path).toBe(rowOf(first).rel_path)
    expect(rowOf(second).sha256).toBe(rowOf(first).sha256)
    expect(filesUnder(env.root)).toHaveLength(1)
  })

  it('去重命中的物理文件被外部删掉时会重写，不会留一条指向空处的行', () => {
    const first = attachmentService.add({
      name: 'a.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    rmSync(absOf(first))
    expect(existsSync(absOf(first))).toBe(false)

    const second = attachmentService.add({
      name: 'b.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    expect(rowOf(second).rel_path).toBe(rowOf(first).rel_path)
    expect(readFileSync(absOf(second))).toEqual(PNG_1X1)
  })

  it('同字节不同 mime：磁盘两个文件、两行，扩展名各随自己的 mime（02 §3.3b v0.13）', () => {
    const b64 = PNG_1X1.toString('base64')
    const png = attachmentService.add({ name: 'a.png', mime: 'image/png', base64: b64 })
    const pdf = attachmentService.add({ name: 'a.pdf', mime: 'application/pdf', base64: b64 })

    expect(pdf.id).not.toBe(png.id)
    expect(rowOf(pdf).sha256).toBe(rowOf(png).sha256)
    // 去重键带 mime：第二种 mime 不复用第一次的 .png，避免扩展名与 Content-Type 长期打架
    expect(rowOf(png).rel_path.endsWith('.png')).toBe(true)
    expect(rowOf(pdf).rel_path.endsWith('.pdf')).toBe(true)
    expect(rowOf(pdf).rel_path).not.toBe(rowOf(png).rel_path)
    expect(rowOf(pdf).mime).toBe('application/pdf')
    expect(filesUnder(env.root)).toHaveLength(2)
  })
})

describe('attachmentService.add · sourcePath', () => {
  it('10 MiB PDF 走 sourcePath 能落盘（是真拷贝，不是引用源文件）', () => {
    const size = 10 * 1024 * 1024
    const src = writeTempSource(env.base, '报告.pdf', fakePdf(size))

    const att = attachmentService.add({
      name: '报告.pdf',
      mime: 'application/pdf',
      sourcePath: src
    })

    expect(att.kind).toBe('file')
    expect(att.bytes).toBe(size)
    const abs = absOf(att)
    expect(rowOf(att).rel_path.endsWith('.pdf')).toBe(true)
    expect(statSync(abs).size).toBe(size)

    // 源文件删掉后目标还在，说明是拷贝而不是软链/引用
    rmSync(src)
    expect(statSync(abs).size).toBe(size)
    expect(attachmentService.read(att.id).bytes.byteLength).toBe(size)
  })

  it('26 MiB 返回 FILE_TOO_LARGE，且不落盘、不插行', () => {
    const src = writeTempSource(env.base, 'big.pdf', fakePdf(26 * 1024 * 1024))
    expectErrorCode(
      () => attachmentService.add({ name: 'big.pdf', mime: 'application/pdf', sourcePath: src }),
      'FILE_TOO_LARGE'
    )
    expect(filesUnder(env.root)).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 })
  })

  it('sourcePath 优先于 base64（两个都给时按 sourcePath 的内容落盘）', () => {
    const pdf = fakePdf(2048)
    const src = writeTempSource(env.base, 'a.pdf', pdf)

    const att = attachmentService.add({
      name: 'a.pdf',
      mime: 'application/pdf',
      sourcePath: src,
      base64: PNG_1X1.toString('base64')
    })

    expect(att.bytes).toBe(pdf.byteLength)
    expect(readFileSync(absOf(att))).toEqual(pdf)
  })

  it('sourcePath 不存在 → INVALID_INPUT（不是 FILE_TOO_LARGE/DB_ERROR）', () => {
    expectErrorCode(
      () =>
        attachmentService.add({
          name: 'x.pdf',
          mime: 'application/pdf',
          sourcePath: join(env.base, '没有这个文件.pdf')
        }),
      'INVALID_INPUT'
    )
  })

  it('sourcePath 指到目录 → INVALID_INPUT', () => {
    expectErrorCode(
      () => attachmentService.add({ name: 'x.pdf', mime: 'application/pdf', sourcePath: env.base }),
      'INVALID_INPUT'
    )
  })
})

describe('attachmentService.add · 拒绝', () => {
  it('非白名单 mime → UNSUPPORTED_MIME，且不落盘', () => {
    expectErrorCode(
      () =>
        attachmentService.add({
          name: 'x.html',
          mime: 'text/html',
          base64: Buffer.from('<h1>hi</h1>').toString('base64')
        }),
      'UNSUPPORTED_MIME'
    )
    expect(filesUnder(env.root)).toEqual([])
  })

  it('白名单里的空白字符变体（image/jpg）不算 image/jpeg', () => {
    expectErrorCode(
      () =>
        attachmentService.add({
          name: 'x.jpg',
          mime: 'image/jpg',
          base64: PNG_1X1.toString('base64')
        }),
      'UNSUPPORTED_MIME'
    )
  })

  it('base64 与 sourcePath 都不给 → INVALID_INPUT', () => {
    expectErrorCode(
      () => attachmentService.add({ name: 'x.png', mime: 'image/png' }),
      'INVALID_INPUT'
    )
  })

  it('base64 不是合法编码 → INVALID_INPUT（不能静默解出半个文件）', () => {
    expectErrorCode(
      () => attachmentService.add({ name: 'x.png', mime: 'image/png', base64: 'iVBORw0KGgo$%%%' }),
      'INVALID_INPUT'
    )
    expect(filesUnder(env.root)).toEqual([])
  })

  it('base64 解码后超过 25 MiB → FILE_TOO_LARGE，且不落盘不插行', () => {
    const big = fakePdf(26 * 1024 * 1024).toString('base64')
    expectErrorCode(
      () => attachmentService.add({ name: 'big.pdf', mime: 'application/pdf', base64: big }),
      'FILE_TOO_LARGE'
    )
    expect(filesUnder(env.root)).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 })
  })

  it('超长 base64 串在解码之前就被拒：非法字符也报 FILE_TOO_LARGE 而非 INVALID_INPUT', () => {
    // 串里全是解码器必然拒绝的字符——若预检不存在，会先走到 base64 字母表校验报
    // INVALID_INPUT；报 FILE_TOO_LARGE 本身就证明预检发生在解码之前，
    // 26 MiB 的附件不会先在内存里解开 ~35 MB 再被扔掉
    const oversized = '$'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 100)
    expectErrorCode(
      () => attachmentService.add({ name: 'big.png', mime: 'image/png', base64: oversized }),
      'FILE_TOO_LARGE'
    )
    expect(filesUnder(env.root)).toEqual([])
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 })
  })

  it('串长预检不误杀：整 25 MiB 的 base64 能正常落盘', () => {
    const att = attachmentService.add({
      name: 'edge.pdf',
      mime: 'application/pdf',
      base64: fakePdf(MAX_ATTACHMENT_BYTES).toString('base64')
    })
    expect(att.bytes).toBe(MAX_ATTACHMENT_BYTES)
    expect(statSync(absOf(att)).size).toBe(MAX_ATTACHMENT_BYTES)
  })

  it('空内容 → INVALID_INPUT', () => {
    expectErrorCode(
      () => attachmentService.add({ name: 'x.png', mime: 'image/png', base64: '   ' }),
      'INVALID_INPUT'
    )
  })
})

describe('attachmentService.read', () => {
  it('返回原始字节与 mime', () => {
    const att = attachmentService.add({
      name: 'a.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    const got = attachmentService.read(att.id)
    expect(got.mime).toBe('image/png')
    expect(got.bytes).toEqual(PNG_1X1)
  })

  it('id 传 ../../../etc/passwd → NOT_FOUND，一个字节都不读', () => {
    // 库里真塞一行这个 id：形状校验必须在查库之前生效，否则就会顺着 rel_path 去读文件
    attachmentRepo.insert({
      id: '../../../etc/passwd',
      messageId: null,
      kind: 'image',
      relPath: '../../../etc/passwd',
      mime: 'image/png',
      bytes: 1,
      sha256: 'y'.repeat(64),
      createdAt: '2026-10-28T00:00:00.000Z'
    })

    expectErrorCode(() => attachmentService.read('../../../etc/passwd'), 'NOT_FOUND')
    expectErrorCode(() => attachmentService.read('..'), 'NOT_FOUND')
    expectErrorCode(() => attachmentService.read(''), 'NOT_FOUND')
  })

  it('形状合法但库里没有 → NOT_FOUND', () => {
    expectErrorCode(() => attachmentService.read('AAAAAAAAAAAA'), 'NOT_FOUND')
  })

  it('行在文件丢了 → NOT_FOUND（不是 UNKNOWN）', () => {
    const att = attachmentService.add({
      name: 'a.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    rmSync(absOf(att))
    expectErrorCode(() => attachmentService.read(att.id), 'NOT_FOUND')
  })
})

describe('attachmentService · 磁盘失败 → IO_ERROR（02 §3.3b v0.13）', () => {
  it('写盘失败（目标目录被文件占住）→ IO_ERROR，且不插行', () => {
    // root/2026 被一个普通文件占住，mkdirSync 建 root/2026/10 时必然失败
    writeFileSync(join(env.root, '2026'), 'not a directory')
    expectErrorCode(
      () =>
        attachmentService.add({
          name: 'a.png',
          mime: 'image/png',
          base64: PNG_1X1.toString('base64')
        }),
      'IO_ERROR'
    )
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 })
    // 没有留下 .part 残片
    expect(filesUnder(env.root)).toEqual(['2026'])
  })

  it('读盘失败（rel_path 指到目录）→ IO_ERROR，不是 NOT_FOUND', () => {
    mkdirSync(join(env.root, '2026', '10'), { recursive: true })
    attachmentRepo.insert({
      id: 'AAAAAAAAAAAA',
      messageId: null,
      kind: 'file',
      relPath: '2026/10',
      mime: 'image/png',
      bytes: 1,
      sha256: 'z'.repeat(64),
      createdAt: '2026-10-28T00:00:00.000Z'
    })
    expectErrorCode(() => attachmentService.read('AAAAAAAAAAAA'), 'IO_ERROR')
  })
})

describe('attachmentRepo · 行级 CRUD', () => {
  it('挂到消息上之后能按 message 取回，批量取按 message_id 分组', () => {
    const message = messageService.appendMessage({ role: 'user', kind: 'text', contentMd: '看图' })
    const other = messageService.appendMessage({ role: 'user', kind: 'text', contentMd: '另一条' })

    const a = attachmentService.add({
      name: 'a.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    const b = attachmentService.add({
      name: 'b.png',
      mime: 'image/png',
      base64: Buffer.concat([PNG_1X1, Buffer.from([0])]).toString('base64')
    })
    attachmentRepo.attachToMessage(message.id, [a.id, b.id])

    expect(attachmentRepo.listAttachments(message.id).map(x => x.id)).toEqual([a.id, b.id])
    expect(attachmentRepo.listAttachments(other.id)).toEqual([])

    const grouped = attachmentRepo.attachmentsFor([message.id, other.id])
    expect(grouped.get(message.id)?.map(x => x.id)).toEqual([a.id, b.id])
    expect(grouped.get(other.id)).toBeUndefined()

    expect(attachmentRepo.attachmentById(a.id)?.url).toBe(`app://attach/${a.id}`)
    expect(attachmentRepo.attachmentById('AAAAAAAAAAAA')).toBeNull()
  })

  it('remove 只删行不删文件（物理文件 v1 只增不删）', () => {
    const att = attachmentService.add({
      name: 'a.png',
      mime: 'image/png',
      base64: PNG_1X1.toString('base64')
    })
    const abs = absOf(att)
    attachmentRepo.remove(att.id)

    expect(attachmentRepo.attachmentRowById(att.id)).toBeNull()
    expect(existsSync(abs)).toBe(true)
  })

  it('messageRepo 仍同名转出四个附件函数（messageService 的调用点不许改）', () => {
    expect(messageRepo.insertAttachment).toBe(attachmentRepo.insert)
    expect(messageRepo.listAttachments).toBe(attachmentRepo.listAttachments)
    expect(messageRepo.attachToMessage).toBe(attachmentRepo.attachToMessage)
    expect(messageRepo.removeAttachment).toBe(attachmentRepo.remove)
  })
})
