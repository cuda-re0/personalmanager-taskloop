import type { AppError, AppErrorCode } from '../../shared/types/ipc'

/**
 * 带 `AppError` 载荷的异常。
 * 数据层不自造错误码：一律用 02 §1.2 的 `AppErrorCode`，W2 直接把 `.toAppError()` 塞进
 * `IpcResult` 的 `ok:false` 分支即可，不需要再翻译一次。
 */
export class AppErrorException extends Error implements AppError {
  readonly code: AppErrorCode
  readonly detail?: string
  readonly retryable: boolean

  constructor(
    code: AppErrorCode,
    message: string,
    opts?: { detail?: string; retryable?: boolean; cause?: unknown }
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'AppErrorException'
    this.code = code
    this.detail = opts?.detail
    this.retryable = opts?.retryable ?? false
  }

  toAppError(): AppError {
    return { code: this.code, message: this.message, detail: this.detail, retryable: this.retryable }
  }
}

export function appError(
  code: AppErrorCode,
  message: string,
  opts?: { detail?: string; retryable?: boolean; cause?: unknown }
): AppErrorException {
  return new AppErrorException(code, message, opts)
}

/** SQLite 约束冲突（唯一索引 / 外键 / CHECK）。better-sqlite3 抛的是 SqliteError，code 形如 SQLITE_CONSTRAINT_UNIQUE */
export function isConstraintError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true
  const message = e instanceof Error ? e.message : ''
  return message.includes('UNIQUE constraint failed') || message.includes('FOREIGN KEY constraint failed')
}

/** 把约束冲突翻成业务可读的 CONFLICT；其余异常原样包成 DB_ERROR */
export function wrapWriteError(e: unknown, conflictMessage: string): AppErrorException {
  if (e instanceof AppErrorException) return e
  if (isConstraintError(e)) {
    return appError('CONFLICT', conflictMessage, {
      detail: e instanceof Error ? e.message : String(e),
      cause: e
    })
  }
  return appError('DB_ERROR', '数据库读写失败', {
    detail: e instanceof Error ? e.message : String(e),
    retryable: true,
    cause: e
  })
}
