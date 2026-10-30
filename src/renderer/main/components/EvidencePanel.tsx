import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import type { EvidenceView } from '../features/chat/chatTypes'
import { mimeExt } from '../features/chat/chatViewModel'

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
  onPick(file: File): void
  onOpen(url: string): void
}

/**
 * 一条证据。v0.8 起 Evidence 只有 text / attachment：图片给缩略图，
 * 其余附件（PDF 等）给类型角标（`Attachment` 没有 name，04 §3.3）。
 *
 * v0.35 裁决：**证据不可删**——主进程没有删除通道，所以这里不渲染任何移除控件。
 */
function EvidenceChip({
  item,
  onOpen
}: {
  item: EvidenceView
  onOpen(url: string): void
}): ReactElement {
  if (item.kind === 'attachment' && item.attachmentKind === 'image' && item.url) {
    return (
      <span className="ev-thumb">
        <img alt="" className="ev-thumb-img" onClick={() => onOpen(item.url as string)} src={item.url} />
      </span>
    )
  }
  return (
    <span className={`ev-text ${item.kind === 'attachment' ? 'ev-file' : ''}`}>
      <span className="ev-text-body">
        {item.kind === 'attachment' ? mimeExt(item.mime) : item.text}
      </span>
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
  onOpen
}: Props): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (openSignal > 0) inputRef.current?.click()
  }, [openSignal])

  return (
    <div className="review-evidence">
      <span className="review-evidence-label">证据</span>
      {evidence.map(item => (
        <EvidenceChip item={item} key={item.key} onOpen={onOpen} />
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
              if (file) onPick(file)
            }}
            ref={inputRef}
            type="file"
          />
        </>
      ) : null}
    </div>
  )
}
