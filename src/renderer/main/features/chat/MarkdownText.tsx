import type { ReactNode } from 'react'

/**
 * 极简 markdown：段落 / 无序列表 / 有序列表 / 粗体 / 行内代码。
 *
 * 全程只产出 React 文本节点，不拼 HTML、不碰 innerHTML，
 * 所以内容里的 `<script>` 与 `![x](javascript:...)` 只会作为普通字符显示。
 * 也正因为没有图片语法，`javascript:` 链接没有可落地的属性。
 */

type Block =
  | { type: 'p'; lines: string[] }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }

const BULLET = /^[-*]\s+(.*)$/
const ORDERED = /^\d+\.\s+(.*)$/

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let list: Block | null = null

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ type: 'p', lines: para })
      para = []
    }
  }
  const flushList = (): void => {
    if (list) {
      blocks.push(list)
      list = null
    }
  }

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flushPara()
      flushList()
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      flushPara()
      if (!list || list.type !== 'ul') {
        flushList()
        list = { type: 'ul', items: [] }
      }
      list.items.push(bullet[1])
      continue
    }
    const ordered = ORDERED.exec(line)
    if (ordered) {
      flushPara()
      if (!list || list.type !== 'ol') {
        flushList()
        list = { type: 'ol', items: [] }
      }
      list.items.push(ordered[1])
      continue
    }
    flushList()
    para.push(line)
  }
  flushPara()
  flushList()
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g

function renderInline(text: string, prefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  INLINE.lastIndex = 0
  let m = INLINE.exec(text)
  while (m !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${prefix}-${i++}`
    if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      out.push(
        <code className="md-code" key={key}>
          {token.slice(1, -1)}
        </code>
      )
    }
    last = m.index + token.length
    m = INLINE.exec(text)
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function MarkdownText({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text)
  return (
    <div className="md">
      {blocks.map((block, bi) => {
        if (block.type === 'p') {
          const children: ReactNode[] = []
          block.lines.forEach((line, li) => {
            if (li > 0) children.push(<br key={`br-${bi}-${li}`} />)
            children.push(...renderInline(line, `p-${bi}-${li}`))
          })
          return <p key={`b-${bi}`}>{children}</p>
        }
        const items = block.items.map((item, li) => (
          <li key={`b-${bi}-${li}`}>{renderInline(item, `l-${bi}-${li}`)}</li>
        ))
        return block.type === 'ul' ? <ul key={`b-${bi}`}>{items}</ul> : <ol key={`b-${bi}`}>{items}</ol>
      })}
    </div>
  )
}
