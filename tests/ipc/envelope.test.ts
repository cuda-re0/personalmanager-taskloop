import { describe, expect, it } from 'vitest'
import { appError } from '../../src/main/db/errors'
import { runEnvelope, toErrorEnvelope } from '../../src/main/ipc/envelope'

describe('envelope（IPC 信封收口）', () => {
  it('AppErrorException → ok:false，code/message/detail/retryable 原样透传', () => {
    const thrown = appError('NOT_FOUND', '任务不存在', { detail: 'id=abc' })
    const result = toErrorEnvelope(thrown)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      code: 'NOT_FOUND',
      message: '任务不存在',
      detail: 'id=abc',
      retryable: false
    })
  })

  it('普通 Error → UNKNOWN「未知错误」，detail 带原始信息，retryable=false', () => {
    const result = toErrorEnvelope(new Error('boom'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN')
    expect(result.error.message).toBe('未知错误')
    expect(result.error.detail).toBe('boom')
    expect(result.error.retryable).toBe(false)
  })

  it('非 Error 的抛出物 → UNKNOWN，detail 是字符串化的原始信息', () => {
    const result = toErrorEnvelope('直接抛字符串')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('UNKNOWN')
    expect(result.error.detail).toBe('直接抛字符串')
  })

  it('正常返回 → ok:true', () => {
    expect(runEnvelope(() => 42)).toEqual({ ok: true, data: 42 })
  })

  it('同步抛错不外抛，收口成 ok:false', () => {
    const result = runEnvelope(() => {
      throw appError('CONFLICT', '冲突')
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: '冲突' } })
  })

  it('异步 handler 的拒绝同样收口成 ok:false', async () => {
    const result = await runEnvelope(() => Promise.reject(new Error('async boom')))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('UNKNOWN')
      expect(result.error.detail).toBe('async boom')
    }
  })
})
