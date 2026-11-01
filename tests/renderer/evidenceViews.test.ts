import { describe, expect, it } from 'vitest'
import type { Attachment, Evidence } from '../../src/shared/types/domain'
import { toEvidenceViews, filesFromDrop } from '../../src/renderer/main/features/chat/chatViewModel'

/**
 * 证据视图转换（施工词 33 §2(b) / §7.5）。
 *
 * 三条：文字证据照样渲染；附件命中缓存就给 url/kind/mime；**未命中直接跳过**
 * （不造占位符、不写「附件失效」这类新文案）。函数必须是纯的——只查表，不发 IPC。
 */
function attachmentOf(id: string): Attachment {
  return {
    id,
    kind: 'image',
    name: '证据.png',
    url: `app://attach/${id}`,
    mime: 'image/png',
    bytes: 1024,
    width: 96,
    height: 96
  }
}

const NOW = '2026-10-30T12:00:00.000Z'

describe('toEvidenceViews（纯函数）', () => {
  it('text 一条：原样转出，没有 url / kind', () => {
    const views = toEvidenceViews([{ kind: 'text', text: '已经发给助教', addedAt: NOW }], {})
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      kind: 'text',
      text: '已经发给助教',
      url: null,
      attachmentKind: null,
      mime: null
    })
  })

  it('attachment 命中缓存：带 url / attachmentKind / mime', () => {
    const evidence: Evidence[] = [{ kind: 'attachment', attachmentId: 'att-1', addedAt: NOW }]
    const views = toEvidenceViews(evidence, { 'att-1': attachmentOf('att-1') })
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      kind: 'attachment',
      url: 'app://attach/att-1',
      attachmentKind: 'image',
      mime: 'image/png'
    })
  })

  it('attachment 未命中缓存：整条跳过，不占位', () => {
    const evidence: Evidence[] = [
      { kind: 'attachment', attachmentId: 'att-missing', addedAt: NOW },
      { kind: 'text', text: '剩下的', addedAt: NOW }
    ]
    const views = toEvidenceViews(evidence, {})
    expect(views).toHaveLength(1)
    expect(views[0].text).toBe('剩下的')
  })
})

/**
 * 拖放进来的文件清单（v0.57 §3.6）。
 * 泛型入参，测试里用普通数组代替 `FileList`——测试环境没有 DOM。
 */
describe('filesFromDrop（纯函数）', () => {
  it('canAccept === false：即使有 3 个文件也返回空', () => {
    expect(filesFromDrop(['a', 'b', 'c'], false)).toEqual([])
  })

  it('files === null：返回空', () => {
    expect(filesFromDrop<string>(null, true)).toEqual([])
  })

  it('正常：3 个元素原顺序返回', () => {
    expect(filesFromDrop(['a', 'b', 'c'], true)).toEqual(['a', 'b', 'c'])
  })
})
