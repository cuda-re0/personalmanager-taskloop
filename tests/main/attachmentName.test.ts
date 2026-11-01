import { describe, expect, it } from 'vitest'
import { displayName } from '../../src/main/attachments/constants'

describe('displayName（49 §2.3）：用户文件名 → 存库用的显示名', () => {
  it('换行/制表符压成空格、连续空白合一、首尾 trim', () => {
    expect(displayName('  屏幕\n截图\t 2026.png  ', 'image/png')).toBe('屏幕 截图 2026.png')
  })

  it('清洗后为空 → 回退成 kind.ext，不是空串也不是 mime 原文', () => {
    expect(displayName('', 'image/png')).toBe('image.png')
    expect(displayName('   ', 'application/pdf')).toBe('file.pdf')
  })
})
