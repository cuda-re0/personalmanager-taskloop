import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/main/db/defaultSettings'
import {
  AI_VENDORS,
  AI_VENDOR_PRESETS,
  vendorOf
} from '../../src/renderer/main/features/settings/aiVendor'

describe('AI 供应商预设', () => {
  it('vendorOf 按域名识别供应商，认不出的返回 null', () => {
    expect(vendorOf('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu')
    expect(vendorOf('https://api.deepseek.com')).toBe('deepseek')
    expect(vendorOf('https://api.deepseek.com/v1')).toBe('deepseek')
    expect(vendorOf('  HTTPS://API.DeepSeek.COM/  ')).toBe('deepseek')
    expect(vendorOf('')).toBeNull()
    expect(vendorOf('https://example.com/v1')).toBeNull()
  })

  it('两组预设三项都非空，且智谱组与 DEFAULT_SETTINGS 完全一致', () => {
    for (const v of AI_VENDORS) {
      expect(AI_VENDOR_PRESETS[v].task).not.toBe('')
      expect(AI_VENDOR_PRESETS[v].chat).not.toBe('')
      expect(AI_VENDOR_PRESETS[v].baseUrl).not.toBe('')
    }
    expect(AI_VENDOR_PRESETS.zhipu.baseUrl).toBe(DEFAULT_SETTINGS['ai.baseUrl'])
    expect(AI_VENDOR_PRESETS.zhipu.task).toBe(DEFAULT_SETTINGS['ai.provider'].model)
    expect(AI_VENDOR_PRESETS.zhipu.chat).toBe(DEFAULT_SETTINGS['ai.chat.model'])
  })
})
