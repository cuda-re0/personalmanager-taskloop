import { describe, expect, it } from 'vitest'
import { setKey } from '../../src/main/services/aiService'

/**
 * `aiService.setKey` 的两条边界（v0.47 §5）。
 *
 * 测试宿主里 `app` / `safeStorage` 是 `undefined`，`encryptionAvailable()` 返回 false，
 * `writeKey` 必然返回 false——所以「保存失败」这条是稳定断言，不是碰运气。
 * 也正因为这里跑不到成功分支，**不许**在这份测试里断言"写入成功"。
 */

function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('预期抛错，但没有抛')
}

describe('aiService.setKey', () => {
  it('空串与纯空格都报「API Key 不能为空」', () => {
    expect(messageOf(() => setKey(''))).toBe('API Key 不能为空')
    expect(messageOf(() => setKey('   '))).toBe('API Key 不能为空')
  })

  it('加密不可用时报「API Key 保存失败」，且 message 里不含 key 本身', () => {
    const message = messageOf(() => setKey('sk-test-123'))
    expect(message).toBe('API Key 保存失败')
    expect(message).not.toContain('sk-test')
  })
})
