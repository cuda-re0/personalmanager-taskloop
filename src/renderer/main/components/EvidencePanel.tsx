import { useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactElement } from 'react'
import type { EvidenceView } from '../features/chat/chatTypes'
import { filesFromDrop, mimeExt } from '../features/chat/chatViewModel'

interface Props {
  evidence: EvidenceView[]
  /** 有动作在飞：`[+]` 与文件选择一并禁用（一次一个动作） */
  busy: boolean
  /**
   * 还能不能加证据（v0.38，判据**只能是任务状态**）。
   * false 时 `[+]` 与隐藏的 `<input type="file">` **都不进 DOM**——`done` / `missed` /
   * `discarded` / `archived` 的卡上不该有一颗能点却没有任何出口的加号。
   */
  canAdd: boolean
  /** 数字递增即打开文件选择——卡片动作区的 `[补证据]` 与行末 `[+]` 共用这一个 input */
  openSignal: number
  /** 拿到的 Promise 会被拖放路径 await（v0.57：多文件串行上传） */
  onPick(file: File): Promise<unknown> | void
  onOpen(url: string): void
  /**
   * 删一条证据（v0.61）。**不传就不渲染 ×** —— 审核卡走的就是这条：
   * 那张卡上的证据是已经送审的事实，不给撤回入口。`index` 是 `EvidenceView.index`。
   */
  onRemove?(index: number): void
}

/**
 * 一条证据。v0.8 起 Evidence 只有 text / attachment：图片给缩略图，
 * 其余附件（PDF 等）给类型角标（`Attachment` 没有 name，04 §3.3）。
 *
 * v0.35 裁决「证据不可删」在 v0.61 改为**按卡区分**：待提交卡取消/重选后旧图还挂着会干扰，
 * 所以那里给每一条配一个 ×；审核卡仍然不渲染任何移除控件。
 */
function EvidenceChip({
  item,
  onOpen,
  onRemove,
  busy
}: {
  item: EvidenceView
  onOpen(url: string): void
  onRemove?: (index: number) => void
  busy: boolean
}): ReactElement {
  const del =
    onRemove === undefined ? null : (
      <button
        className="ev-remove"
        disabled={busy}
        onClick={() => onRemove(item.index)}
        type="button"
      >
        ×
      </button>
    )

  if (item.kind === 'attachment' && item.attachmentKind === 'image' && item.url) {
    return (
      <span className="ev-thumb">
        <img alt="" className="ev-thumb-img" onClick={() => onOpen(item.url as string)} src={item.url} />
        {del}
      </span>
    )
  }
  return (
    <span className={`ev-text ${item.kind === 'attachment' ? 'ev-file' : ''}`}>
      <span className="ev-text-body">
        {item.kind === 'attachment' ? mimeExt(item.mime) : item.text}
      </span>
      {del}
    </span>
  )
}

/**
 * 审核卡 / 待提交卡上的证据区（施工词 33 §4 / 36 §8）。
 *
 * 只做三件事：列出已加证据、提供一个**真的**选文件入口、上传期间禁用。
 * 大小与 mime 校验全在主进程（`FILE_TOO_LARGE` / `UNSUPPORTED_MIME`），
 * 这里不设 `accept`、不预判，错误原文由卡片显示。
 */
export function EvidencePanel({
  evidence,
  busy,
  canAdd,
  openSignal,
  onPick,
  onOpen,
  onRemove
}: Props): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** 拖放高亮（v0.57）：只在"能收且不忙"时亮 */
  const [over, setOver] = useState(false)
  /** 上一轮串行上传还没跑完时，再拖进来的整批丢弃（不排队） */
  const droppingRef = useRef(false)

  useEffect(() => {
    if (openSignal > 0) inputRef.current?.click()
  }, [openSignal])

  const accept = canAdd && !busy

  /** 始终 preventDefault：不这么做浏览器就不认这里是放置区 */
  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.dataTransfer.dropEffect = accept ? 'copy' : 'none'
  }

  const handleDragEnter = (): void => {
    if (accept) setOver(true)
  }

  /** 划过子元素也会触发 dragleave：还在容器内就不清高亮，否则会闪 */
  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null
    if (next !== null && event.currentTarget.contains(next)) return
    setOver(false)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setOver(false)
    const files = filesFromDrop(event.dataTransfer.files, accept)
    if (files.length === 0) return
    if (droppingRef.current) return
    droppingRef.current = true
    void (async () => {
      try {
        // 逐个串行：现有链路一次只收一个文件
        for (const file of files) await onPick(file)
      } finally {
        droppingRef.current = false
      }
    })()
  }

  return (
    <div
      className={`review-evidence${over && accept ? ' review-evidence--over' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <span className="review-evidence-label">证据</span>
      {evidence.map(item => (
        <EvidenceChip busy={busy} item={item} key={item.key} onOpen={onOpen} onRemove={onRemove} />
      ))}
      {canAdd ? (
        <>
          <button
            aria-label="添加文件"
            className="ev-add"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            +
          </button>
          <input
            className="ev-file-input"
            disabled={busy}
            onChange={event => {
              const file = event.target.files?.[0]
              // 清掉 value，同一个文件再选一次也能触发 onChange
              event.target.value = ''
              if (file) void onPick(file)
            }}
            ref={inputRef}
            type="file"
          />
        </>
      ) : null}
    </div>
  )
}
