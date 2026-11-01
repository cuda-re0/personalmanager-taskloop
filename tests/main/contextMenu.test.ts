import { describe, expect, it } from 'vitest'
import { EDIT_MENU_LABELS, buildEditMenuTemplate } from '../../src/main/contextMenu'

/**
 * `buildEditMenuTemplate` 是纯函数，只测它。
 * `installContextMenu` 要真 `BrowserWindow`、`retry` 要真 IPC，都靠手点（50 §6）。
 */

const ALL_ENABLED = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }

describe('buildEditMenuTemplate（50 §6）：四项永远都在，顺序固定', () => {
  it('四项全可用：标签依次剪切/复制/粘贴/全选，只有全选带分隔线', () => {
    const items = buildEditMenuTemplate(ALL_ENABLED)

    expect(items).toHaveLength(4)
    expect(items.map(item => item.label)).toEqual([...EDIT_MENU_LABELS])
    expect(items.every(item => item.enabled)).toBe(true)

    // 第 4 项是 true；前 3 项**没有这个字段**（不是 false）
    expect(items[3].separatorBefore).toBe(true)
    expect('separatorBefore' in items[0]).toBe(false)
    expect('separatorBefore' in items[1]).toBe(false)
    expect('separatorBefore' in items[2]).toBe(false)
  })

  it('canPaste 为 false：只有「粘贴」禁用，其余三项仍可用', () => {
    const items = buildEditMenuTemplate({ ...ALL_ENABLED, canPaste: false })

    expect(items.map(item => item.enabled)).toEqual([true, true, false, true])
    expect(items[2].label).toBe(EDIT_MENU_LABELS[2])
  })

  it('四个 flag 全 false：四项都在、四项都禁用（不许返回空数组）', () => {
    const items = buildEditMenuTemplate({
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false
    })

    expect(items).toHaveLength(4)
    expect(items.every(item => item.enabled)).toBe(false)
  })
})
