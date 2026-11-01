import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import type { Attachment } from '../../shared/types/domain'
import {
  attachmentRelPath,
  attachmentRoot,
  isAttachmentId,
  resolveWithinRoot
} from '../attachments/paths'
import {
  MAX_ATTACHMENT_BYTES,
  displayName,
  extForMime,
  kindForMime,
  normalizeMime
} from '../attachments/constants'
import { appError } from '../db/errors'
import { newId } from '../db/ids'
import { nowIso } from '../db/localDay'
import * as attachmentRepo from '../db/repositories/attachmentRepo'

/**
 * attachmentService —— 唯一"把字节搬进系统"的入口（02 §3.3b）。
 *
 * 流程固定：校验 → sha256 → 查重 → 落盘 → 插行 → 返回带 `app://attach/<id>` 的 `Attachment`。
 *
 * 几条不能商量的：
 * - 落盘路径里的 id 是本服务生成的，扩展名由 mime 推导，**用户传的 `name` 一个字符都不进路径**
 * - 先去重再落盘：同内容第二次进来只插一行、不写第二个文件（`idx_attachments_sha`）
 * - 先落盘再插行：反过来会留下"有行没文件"的坏记录（协议/read 都 404），而"有文件没行"
 *   只是白占几十 KB，v1 还得靠它去重
 * - `read()` 只给主进程内部用（W4 组多模态），**不注册 IPC**
 */

export interface AddAttachmentInput {
  name: string
  mime: string
  base64?: string
  sourcePath?: string
}

export interface AttachmentBytes {
  bytes: Buffer
  mime: string
}

/** 已读入内存的待落盘内容：要么是源文件（走 copyFile），要么是解出来的字节 */
type Payload =
  | { kind: 'file'; sourcePath: string; size: number }
  | { kind: 'buffer'; buffer: Buffer; size: number }

/** 日志里的文件名：单行、截断。它只用于日志，绝不参与拼路径 */
function logName(raw: string): string {
  const oneLine = raw.replace(/[\r\n\t]+/g, ' ').trim()
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine
}

/**
 * base64 串长预检的余量：`data:` 前缀、空白、padding 最多占几十字符，
 * 而上界估计（串长 × 3/4）本身只会高估解码字节数，多留这点余量不可能误杀合法文件。
 */
const BASE64_PRECHECK_SLACK = 64

function assertSize(size: number, label: string): number {
  if (size > MAX_ATTACHMENT_BYTES) {
    throw appError('FILE_TOO_LARGE', `附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB 上限`, {
      detail: `${label} 为 ${size} 字节`
    })
  }
  if (size <= 0) {
    throw appError('INVALID_INPUT', '附件内容为空', { detail: `${label} 为 0 字节` })
  }
  return size
}

function fromSourcePath(sourcePath: string): Payload {
  let stat
  try {
    stat = statSync(sourcePath)
  } catch (e) {
    throw appError('INVALID_INPUT', '附件源文件不存在或不可读', {
      detail: `${sourcePath}：${e instanceof Error ? e.message : String(e)}`,
      cause: e
    })
  }
  if (!stat.isFile()) {
    throw appError('INVALID_INPUT', '附件源路径不是普通文件', { detail: sourcePath })
  }
  // 先按 size 拦下超限，避免为了算 sha256 去读 26 MiB
  return { kind: 'file', sourcePath, size: assertSize(stat.size, '源文件') }
}

/** `data:<mime>;base64,` 前缀允许存在（`FileReader.readAsDataURL` 的结果直接可用），其余按裸 base64 处理 */
function decodeBase64(raw: string): Buffer {
  const trimmed = raw.trim()
  const marker = trimmed.startsWith('data:') ? trimmed.indexOf(',') : -1
  const payload = (marker >= 0 ? trimmed.slice(marker + 1) : trimmed).replace(/\s+/g, '')
  if (payload.length === 0) {
    throw appError('INVALID_INPUT', '附件内容为空', { detail: 'base64 为空' })
  }
  // Buffer.from(s,'base64') 会静默丢掉非法字符、把坏数据解成半个文件，所以先验字母表
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    throw appError('INVALID_INPUT', '附件内容不是合法的 base64', {
      detail: `长度为 ${payload.length}`
    })
  }
  return Buffer.from(payload, 'base64')
}

function resolvePayload(input: AddAttachmentInput): Payload {
  const hasSource = typeof input.sourcePath === 'string' && input.sourcePath.length > 0
  const hasBase64 = typeof input.base64 === 'string' && input.base64.length > 0
  // 02 §3.3b：两个都给以 sourcePath 为准（它是 webUtils 拿到的真实路径，比 base64 更接近原文件）
  if (hasSource) return fromSourcePath(input.sourcePath as string)
  if (hasBase64) {
    const raw = input.base64 as string
    // 解码**前**按串长预检：base64 每 4 字符对应 3 字节，串长 × 3/4 只会**高估**解码结果
    // （padding 与空白只减不增），所以这个上界不会误杀合法的 25 MiB。
    // 否则 26 MiB 的附件要先在内存里解开 ~35 MB 再拒——白吃一次峰值。
    if (raw.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + BASE64_PRECHECK_SLACK) {
      throw appError('FILE_TOO_LARGE', `附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB 上限`, {
        detail: `base64 串长约 ${raw.length} 字符，解码后必超上限`
      })
    }
    const buffer = decodeBase64(raw)
    return { kind: 'buffer', buffer, size: assertSize(buffer.byteLength, 'base64 解码结果') }
  }
  throw appError('INVALID_INPUT', '附件缺少内容：sourcePath 与 base64 至少给一个')
}

function sha256Of(payload: Payload): string {
  const hash = createHash('sha256')
  if (payload.kind === 'buffer') {
    hash.update(payload.buffer)
  } else {
    hash.update(readFileSync(payload.sourcePath))
  }
  return hash.digest('hex')
}

/** 目标文件在（且长度对得上）就不重写。长度不对说明上次写了一半，重写一遍 */
function isStored(absPath: string, size: number): boolean {
  if (!existsSync(absPath)) return false
  try {
    return statSync(absPath).size === size
  } catch {
    return false
  }
}

/** 写临时文件再 rename：写到一半失败不会留下一个"看起来正常"的短文件 */
function writeAtomically(absPath: string, tag: string, payload: Payload): void {
  const tmp = `${absPath}.${tag}.part`
  try {
    mkdirSync(dirname(absPath), { recursive: true })
    if (payload.kind === 'file') copyFileSync(payload.sourcePath, tmp)
    else writeFileSync(tmp, payload.buffer)
    renameSync(tmp, absPath)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理失败不影响主流程：临时文件不会被任何行引用，下次也不会被当成命中
    }
    // 02 §3.3b v0.13：磁盘失败用 IO_ERROR（磁盘满、权限、路径被占用都算），不借 DB_ERROR/UNKNOWN
    throw appError('IO_ERROR', '附件写入磁盘失败', {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    })
  }
}

/**
 * 校验 → sha256 → 查重 → 落盘 → 插行。
 * 返回的 `Attachment.url` 是 `app://attach/<id>`（由 `mapAttachment` 拼，渲染层不拼字符串）。
 */
export function add(input: AddAttachmentInput): Attachment {
  const rawName = typeof input?.name === 'string' ? input.name : ''
  const rawMime = typeof input?.mime === 'string' ? input.mime : ''
  const mime = normalizeMime(rawMime)
  extForMime(mime) // 白名单外直接 UNSUPPORTED_MIME，后面所有步骤都假定 mime 合法

  const payload = resolvePayload(input)
  const sha256 = sha256Of(payload)
  const id = newId()

  // 同内容同 mime 已在磁盘上：复用那行的 rel_path，但**另插一行**（一条记录一个 id，能各自独立删）。
  // 键带 mime（02 §3.3b v0.13）：同字节声明成第二种 mime 时走新文件，扩展名与 Content-Type 才一致
  const existing = attachmentRepo.findBySha(sha256, mime)
  const relPath = existing ? existing.rel_path : attachmentRelPath(id, mime)
  const absPath = resolveWithinRoot(attachmentRoot(), relPath)
  if (!absPath) {
    // 只可能来自库里的 rel_path 被外部改坏；绝不顺着它写文件
    throw appError('INVALID_INPUT', '附件存放路径非法', { detail: `rel_path=${relPath}` })
  }
  if (!isStored(absPath, payload.size)) writeAtomically(absPath, id, payload)

  console.log(
    `[attachment] add ${logName(rawName) || '(未命名)'} → ${relPath} (${mime}, ${payload.size}B)`
  )

  return attachmentRepo.insert({
    id,
    messageId: null,
    taskId: null,
    kind: kindForMime(mime),
    relPath,
    mime,
    bytes: payload.size,
    width: null,
    height: null,
    sha256,
    createdAt: nowIso(),
    // 落库的是**清洗后**的名字（v0.49 §2.3）；日志仍用 logName，两者用途不同
    name: displayName(rawName, mime)
  })
}

/**
 * 按 id 取原始字节（协议处理器与 W4 多模态共用）。**不暴露成 IPC**，渲染层拿不到原始字节。
 *
 * id 形状先校验：`../../../etc/passwd` 这类入参在这里就抛 `NOT_FOUND`，一个字节都不读。
 */
export function read(id: string): AttachmentBytes {
  if (!isAttachmentId(id)) {
    throw appError('NOT_FOUND', '附件不存在', { detail: `id 形状不合法：${JSON.stringify(id)}` })
  }
  const row = attachmentRepo.attachmentRowById(id)
  if (!row) throw appError('NOT_FOUND', '附件不存在', { detail: `id=${id}` })

  const absPath = resolveWithinRoot(attachmentRoot(), row.rel_path)
  if (!absPath)
    throw appError('NOT_FOUND', '附件不存在', { detail: `rel_path 越界：${row.rel_path}` })

  try {
    return { bytes: readFileSync(absPath), mime: row.mime }
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw appError('NOT_FOUND', '附件文件已丢失', { detail: row.rel_path, cause: e })
    }
    throw appError('IO_ERROR', '附件读取失败', {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    })
  }
}
