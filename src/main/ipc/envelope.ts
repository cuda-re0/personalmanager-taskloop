import type { IpcResult } from '@shared/types/ipc'
import { AppErrorException } from '../db/errors'

/**
 * IPC 信封（02 §1.2）：handler 的一切异常在这里收口。
 *
 * - `AppErrorException` → 原样转 `{ok:false, error: e.toAppError()}`
 * - 其他异常 → `UNKNOWN`「未知错误」，detail 带原始信息，console.error 打完整堆栈（主进程日志）
 * - **永远不 throw 到 ipcMain 外面**——渲染层拿到的只能是 `{ok:true,data}` 或 `{ok:false,error}`
 */

export function toErrorEnvelope(e: unknown): IpcResult<never> {
  if (e instanceof AppErrorException) {
    return { ok: false, error: e.toAppError() }
  }
  const detail = e instanceof Error ? e.message : String(e)
  console.error('[ipc] 未捕获异常（UNKNOWN 兜底）', e instanceof Error ? e.stack : e)
  return {
    ok: false,
    error: { code: 'UNKNOWN', message: '未知错误', detail, retryable: false }
  }
}

/**
 * 纯函数包装：同步与异步 handler 都支持。
 * 当前的 service / repo 全是同步方法，异步分支只是留余量，不引入额外调度。
 */
export function runEnvelope(
  fn: () => unknown
): IpcResult<unknown> | Promise<IpcResult<unknown>> {
  try {
    const data = fn()
    if (data instanceof Promise) {
      return data.then(
        resolved => ({ ok: true, data: resolved } as IpcResult<unknown>),
        toErrorEnvelope
      )
    }
    return { ok: true, data }
  } catch (e) {
    return toErrorEnvelope(e)
  }
}
