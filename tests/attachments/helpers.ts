import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initAttachmentRoot, resetAttachmentRoot } from '../../src/main/attachments/paths'
import { closeDb, openDb } from '../../src/main/db/connection'

/**
 * 附件测试的环境。
 *
 * 与 `tests/db/helpers.ts` 的区别只有一处：这里多一个临时附件目录。
 * `npm test` 是 `ELECTRON_RUN_AS_NODE` 起 Electron 内置 node，那种进程里没有 `app`，
 * `app.getPath('userData')` 不可用——所以根目录必须注入，不能等它自己取默认值。
 */
export interface AttachmentEnv {
  /** 临时附件根目录（相当于 userData/attachments） */
  root: string
  /** 临时目录（root 的父级），用来放 sourcePath 的源文件 */
  base: string
  cleanup: () => void
}

export function openAttachmentEnv(tag = 'taskloop-attach'): AttachmentEnv {
  const base = mkdtempSync(join(tmpdir(), `${tag}-`))
  const root = join(base, 'attachments')
  mkdirSync(root, { recursive: true })
  openDb(':memory:')
  initAttachmentRoot(root)
  return {
    root,
    base,
    cleanup: () => {
      closeDb()
      resetAttachmentRoot()
      rmSync(base, { recursive: true, force: true })
    }
  }
}

/** root 下所有文件（相对 root），用来断言"磁盘上只有一个文件" */
export function filesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

/** 写一个临时源文件并返回绝对路径 */
export function writeTempSource(base: string, name: string, bytes: Buffer): string {
  const file = join(base, name)
  writeFileSync(file, bytes)
  return file
}

/** 1×1 透明 PNG（真实字节，不是"看起来像 png"的字符串） */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** 造一个指定大小的"PDF"：内容不真，但字节数、mime、落盘行为都是真的 */
export function fakePdf(bytes: number): Buffer {
  const head = Buffer.from('%PDF-1.7\n% 仅用于测试附件大小上限\n')
  const tail = Buffer.alloc(Math.max(0, bytes - head.length), 0x20)
  return Buffer.concat([head, tail])
}
