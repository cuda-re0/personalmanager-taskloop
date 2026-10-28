import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { appError } from '../db/errors'
import { todayLocalDay } from '../db/localDay'
import { extForMime } from './constants'

/**
 * 附件根目录 + `rel_path` ↔ 绝对路径。
 *
 * **根目录必须可注入**：`npm test` 是用 `ELECTRON_RUN_AS_NODE=1` 起 Electron 内置 node 跑的，
 * 那种进程里 `require('electron')` 拿到的是二进制的路径字符串，`app` 是 `undefined`，
 * `app.getPath('userData')` 根本不存在。所以根目录做成模块级一次性初始化：
 * 生产由 `attachmentRoot()` 懒初始化成 `userData/attachments`，测试在 `beforeEach` 里
 * `initAttachmentRoot(mkdtempSync(...))` 指到临时目录。
 *
 * **路径只能这样产生**：`id` 由服务层生成、扩展名由 mime 推导、`rel_path` 落库后再从行里读回来。
 * 调用方给的文件名/路径永远不会出现在这里。
 */

/** 契约（02 §1.5）里的 id 是 `nanoid(12)`，字母表 `A-Za-z0-9_-` */
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{12}$/

export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value)
}

let root: string | null = null

/** 默认根目录：`app.getPath('userData')/attachments`。非 Electron 环境抛错而不是瞎猜一个目录 */
function defaultRoot(): string {
  if (!app || typeof app.getPath !== 'function') {
    throw appError('DB_ERROR', '无法解析附件目录（非 Electron 环境请先 initAttachmentRoot）', {
      detail: 'app.getPath 不可用'
    })
  }
  return join(app.getPath('userData'), 'attachments')
}

/** 设置附件根目录，不传则取默认值。返回实际生效的目录 */
export function initAttachmentRoot(dir?: string): string {
  root = dir ?? defaultRoot()
  return root
}

/** 当前根目录；未初始化时懒初始化（生产路径） */
export function attachmentRoot(): string {
  return root ?? initAttachmentRoot()
}

/** 仅供测试：清掉注入的目录，让下一次 `attachmentRoot()` 重新取默认值 */
export function resetAttachmentRoot(): void {
  root = null
}

/**
 * `<YYYY>/<MM>/<id>.<ext>`——相对根目录。年月取**本地**日历日（用户看到的月份），
 * 不是 UTC：东八区 11-01 07:00 创建的文件不该进 `2026/10/`。
 */
export function attachmentRelPath(id: string, mime: string, day = todayLocalDay()): string {
  const ext = extForMime(mime)
  return `${day.slice(0, 4)}/${day.slice(5, 7)}/${id}.${ext}`
}

/**
 * `rel_path` → 绝对路径。越界（`..`、绝对路径、盘符）一律返回 `null`，由调用方当 404 处理。
 *
 * 契约已经规定「路径只从库里取」，库里正常写不进 `..`；这一层是纵深防御——
 * 库被外部工具改坏、或将来有人拿 `rel_path` 当入参时，不能变成任意文件读取。
 */
export function resolveWithinRoot(rootDir: string, relPath: string): string | null {
  if (relPath.length === 0 || relPath.includes('\0')) return null
  const base = resolve(rootDir)
  const abs = resolve(base, relPath)
  if (abs === base) return null
  return abs.startsWith(base + sep) ? abs : null
}
