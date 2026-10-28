import { readFileSync } from 'node:fs'
import { protocol } from 'electron'
import * as attachmentRepo from '../db/repositories/attachmentRepo'
import { attachmentRoot } from './paths'
import { handleAttachmentRequest } from './protocol'

/**
 * `app://` 协议的 Electron 侧接线：注册 scheme（ready 前）与挂处理器（ready 后）。
 *
 * **时序不能颠倒**：`registerSchemesAsPrivileged` 必须在 `app.whenReady()` 之前调用，
 * 否则 `secure` / `stream` 这些标志不生效——Electron 33 不会报错，只会让协议退化成
 * "能取到字节但不是安全源、不能流式"，表现是渲染层的图片/PDF 打不开或 CSP 报错，
 * 排查起来毫无线索。所以两个函数分开导出，由 `src/main/index.ts` 分别放在 ready 前后。
 *
 * 处理器本身不判断任何业务规则（那在 `protocol.ts` 的纯函数里），这里只做三件事：
 * 拼 deps、调纯函数、把结果包成 `Response`。
 */

let schemeRegistered = false
let protocolHandled = false

export function registerAttachmentScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true, // 有 host，`app://attach/<id>` 才能按 URL 语义解析
        secure: true, // 算安全源，否则混合内容会被拦
        supportFetchAPI: true, // 渲染层要 fetch 也走得通（当前只用 <img src>）
        stream: true // 大 PDF 不整块读进内存也行
      }
    }
  ])
}

export function registerAttachmentProtocol(): void {
  if (protocolHandled) return
  protocolHandled = true
  protocol.handle('app', request =>
    Promise.resolve(
      handleAttachmentRequest(request.url, {
        root: attachmentRoot,
        lookup: id => {
          const row = attachmentRepo.attachmentRowById(id)
          return row ? { relPath: row.rel_path, mime: row.mime } : null
        },
        readFile: absPath => readFileSync(absPath)
      })
    ).then(res => new Response(res.body, { status: res.status, headers: res.headers }))
  )
}
