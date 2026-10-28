import type { Attachment } from '../../shared/types/domain'
import { appError } from '../db/errors'

/**
 * 附件的大小上限、mime 白名单、扩展名推导（02 §3.3b）。
 *
 * 这里**只**认白名单里的五个 mime。扩展名一律由 mime 推导，用户给的文件名
 * 不参与拼路径（只在日志里出现），所以 mime → ext 的映射必须是封闭表：
 * 表里没有的 mime 直接 `UNSUPPORTED_MIME`，不给"猜一个扩展名"的机会。
 */

/** 单文件 ≤ 25 MiB（02 §3.3b） */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/**
 * 白名单 → 扩展名。键是落盘时用的扩展名，值没有任何其它职责。
 * `image/jpeg` 走 `jpg`（Windows 资源管理器默认隐藏的常见写法），不是 `jpeg`。
 */
export const ATTACHMENT_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf'
} as const

export type AttachmentMime = keyof typeof ATTACHMENT_MIME_EXT

export const ALLOWED_MIMES = Object.keys(ATTACHMENT_MIME_EXT) as AttachmentMime[]

/**
 * mime 归一化：去空白、转小写、丢掉 `; charset=...` 之类的参数。
 * 只做形状卫生，不做等价替换——`image/jpg` 不会被当成 `image/jpeg`，它不在白名单里。
 */
export function normalizeMime(raw: string): string {
  const cut = raw.indexOf(';')
  return (cut >= 0 ? raw.slice(0, cut) : raw).trim().toLowerCase()
}

export function isAllowedMime(mime: string): mime is AttachmentMime {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_MIME_EXT, mime)
}

/** mime → 扩展名；不在白名单里抛 `UNSUPPORTED_MIME` */
export function extForMime(mime: string): string {
  if (!isAllowedMime(mime)) {
    throw appError('UNSUPPORTED_MIME', `不支持的附件类型：${mime || '（空）'}`, {
      detail: `白名单：${ALLOWED_MIMES.join(', ')}`
    })
  }
  return ATTACHMENT_MIME_EXT[mime]
}

/** `Attachment.kind` 只有 image|file 两种：图片类 mime 是 image，其余（当前只有 PDF）是 file */
export function kindForMime(mime: string): Attachment['kind'] {
  return isAllowedMime(mime) && mime.startsWith('image/') ? 'image' : 'file'
}
