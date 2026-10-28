import { isAttachmentId, resolveWithinRoot } from './paths'

/**
 * `app://attach/<id>` 的**纯**请求处理：URL → `{ status, headers, body }`。
 *
 * 为什么不让 `protocol.handle` 直接干活：真协议处理器只能在 Electron 主进程里跑，
 * `npm test` 起的进程里没有 `app`/`protocol`，那三条最该被测的规则（路径穿越、404、
 * Content-Type）就永远只能靠手点。把判定抽成无副作用的函数，`registerProtocol.ts`
 * 只做"转发 + 包 `Response`"，测试直接喂 URL 和假的 deps。
 *
 * 三条硬规则：
 * 1. id 必须是 `nanoid(12)` 形状，形状不对**先 404，不碰文件系统**（`../../../etc/passwd` 走这条）
 * 2. 路径只能来自 `lookup()` 返回的 `relPath`（即库里的 `attachments.rel_path`），
 *    并且再过一遍 `resolveWithinRoot` 挡住库被改坏的情况
 * 3. 查不到行、文件丢了、越界，一律 404（不泄露"存在但读不了"这种信息）
 */

export interface AttachmentProtocolDeps {
  /** 惰性取根目录：取不到（非 Electron 环境）会抛，处理器转 500 */
  root: () => string
  /** 按 id 查行；查不到返回 null。只允许用它拿 relPath，不能接受调用方给的路径 */
  lookup: (id: string) => { relPath: string; mime: string } | null
  readFile: (absPath: string) => Uint8Array
}

export interface AttachmentResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array | null
}

const NOT_FOUND_BODY = new TextEncoder().encode('attachment not found')

function notFound(): AttachmentResponse {
  return {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: NOT_FOUND_BODY
  }
}

function serverError(detail: string): AttachmentResponse {
  return {
    status: 500,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: new TextEncoder().encode(`attachment unavailable: ${detail}`)
  }
}

function isMissingFile(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** `app://attach/<id>` → id；形状不对返回 null */
export function attachmentIdFromUrl(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'app:' || url.hostname !== 'attach') return null
  const id = url.pathname.startsWith('/') ? url.pathname.slice(1) : ''
  return isAttachmentId(id) ? id : null
}

export function handleAttachmentRequest(
  rawUrl: string,
  deps: AttachmentProtocolDeps
): AttachmentResponse {
  const id = attachmentIdFromUrl(rawUrl)
  // 形状不对就到此为止：绝不把这段字符串拼进任何路径
  if (!id) return notFound()

  let row: { relPath: string; mime: string } | null
  try {
    row = deps.lookup(id)
  } catch (e) {
    return serverError(e instanceof Error ? e.message : String(e))
  }
  if (!row) return notFound()

  let absPath: string | null
  try {
    absPath = resolveWithinRoot(deps.root(), row.relPath)
  } catch (e) {
    return serverError(e instanceof Error ? e.message : String(e))
  }
  if (!absPath) return notFound()

  let bytes: Uint8Array
  try {
    bytes = deps.readFile(absPath)
  } catch (e) {
    return isMissingFile(e) ? notFound() : serverError(e instanceof Error ? e.message : String(e))
  }

  // 02 §3.3b v0.13：Content-Disposition 只有 PDF 发 inline（走内置阅读器），
  // 其余**不发这个头**。'default' 不是合法 token（RFC 6266/2183 只认 inline/attachment），
  // Chromium 直接忽略——发它等于没写，还容易让后来人以为这里有个真实语义。
  const headers: Record<string, string> = {
    'content-type': row.mime,
    'content-length': String(bytes.byteLength)
  }
  if (row.mime === 'application/pdf') headers['content-disposition'] = 'inline'

  return {
    status: 200,
    headers,
    body: bytes
  }
}
