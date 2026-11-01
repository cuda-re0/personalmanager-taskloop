import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from 'react'
import type { ChatMode } from '@shared/types/domain'

const MAX_LINES = 6
const LINE_HEIGHT = 22
const MAX_HEIGHT = MAX_LINES * LINE_HEIGHT
/** 一次最多 4 个（03 §5，与守卫的 `.max(4)` 同值）；超出的直接丢，不弹提示 */
const MAX_FILES = 4

interface Props {
  sending: boolean
  /** 双模式开关（v0.42）：只决定按钮上的文字，不改输入行为 */
  mode: ChatMode
  /** 把原始 `File` 交给上层上传（v0.49）：返回 `false` = 失败，输入框保留 */
  onSend(text: string, files: File[]): Promise<boolean>
  onToggleMode(): void
  /** 撤回/编辑后要填回输入框的原文（v0.48）；null = 没有待填 */
  pendingText: string | null
  /** 填回后立刻回调，父层把 pendingText 清成 null */
  onPendingTextUsed(): void
}

/** 已选附件：原始 `File` 留着上传，`previewUrl` 只给预览（object URL，必须 revoke） */
interface PendingFile {
  key: string
  file: File
  previewUrl: string
}

let localSeq = 0

/** 04 §3.4 输入区：1~6 行自适应、Enter 发送 / Shift+Enter 换行、粘贴与拖入图、发送中禁用 */
export function ChatInput({
  sending,
  mode,
  onSend,
  onToggleMode,
  pendingText,
  onPendingTextUsed
}: Props): ReactElement {
  const [value, setValue] = useState('')
  const [files, setFiles] = useState<PendingFile[]>([])
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, MAX_HEIGHT)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [value])

  /**
   * 撤回/编辑的原文回填（v0.48 §5.8）：**覆盖不追加**——用户点编辑就是要重写这句话。
   * 已选附件一并清空：撤回带图的消息时，图已经随消息删了，输入框里不该留着上一轮的待发附件。
   */
  useEffect(() => {
    if (pendingText === null) return
    setValue(pendingText)
    for (const item of files) URL.revokeObjectURL(item.previewUrl)
    setFiles([])
    onPendingTextUsed()
    areaRef.current?.focus()
    // 依赖只放 pendingText：回调变了就把已填的文字重置是不可接受的
  }, [pendingText])

  const canSend = !sending && (value.trim().length > 0 || files.length > 0)

  /**
   * 发送（v0.49 §3.1）：**失败不清空**。上传失败、主进程拒绝、网络异常都返回 `false`，
   * 那时文字与预览全部留在框里，这是用户唯一能看到的失败证据（不弹 toast）。
   */
  const submit = async (): Promise<void> => {
    if (!canSend) return
    const ok = await onSend(
      value,
      files.map(item => item.file)
    )
    if (!ok) return
    setValue('')
    for (const item of files) URL.revokeObjectURL(item.previewUrl)
    setFiles([])
    areaRef.current?.focus()
  }

  const addFiles = (list: FileList | File[]): void => {
    const incoming = Array.from(list)
    if (incoming.length === 0) return
    setFiles(prev => {
      const room = Math.max(0, MAX_FILES - prev.length)
      if (room === 0) return prev
      return [
        ...prev,
        ...incoming.slice(0, room).map(file => {
          localSeq += 1
          return { key: `local-att-${localSeq}`, file, previewUrl: URL.createObjectURL(file) }
        })
      ]
    })
  }

  const removeFile = (key: string): void => {
    setFiles(prev => {
      const target = prev.find(item => item.key === key)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(item => item.key !== key)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void submit()
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = Array.from(event.clipboardData.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (images.length === 0) return
    event.preventDefault()
    addFiles(images)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    // 与 onPick 同一口径：入口不按 mime 过滤，是不是图片交给 file.type 判预览形态。
    // mime 白名单在 attachmentService，拒绝时由主进程给出可读文案。
    addFiles(event.dataTransfer.files)
  }

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.files) addFiles(event.target.files)
    event.target.value = ''
  }

  return (
    <div
      className="chat-input"
      onDragOver={event => event.preventDefault()}
      onDrop={onDrop}
    >
      {files.length > 0 ? (
        <div className="ci-thumbs">
          {files.map(item =>
            item.file.type.startsWith('image/') ? (
              <span className="ci-thumb" key={item.key}>
                <img alt="" className="ci-thumb-img" src={item.previewUrl} />
                <button className="ci-thumb-remove" onClick={() => removeFile(item.key)} type="button">
                  ×
                </button>
              </span>
            ) : (
              <span className="ci-file" key={item.key}>
                <span className="ci-file-name">{item.file.name}</span>
                <button className="ci-thumb-remove" onClick={() => removeFile(item.key)} type="button">
                  ×
                </button>
              </span>
            )
          )}
        </div>
      ) : null}

      <div className="ci-row">
        <button
          aria-label="附件"
          className="ci-plus"
          onClick={() => fileRef.current?.click()}
          type="button"
        >
          +
        </button>
        <input
          accept="image/*"
          className="ci-file-input"
          multiple
          onChange={onPick}
          ref={fileRef}
          type="file"
        />
        {/* v0.42 模式按钮：状态只由按钮文字表达，两种模式配色一致。
            点击只切状态——输入框文字与已选附件都在本组件的 state 里，不会被它重置 */}
        <button
          aria-pressed={mode === 'chat'}
          className={`ci-mode ${mode === 'chat' ? 'ci-mode--chat' : 'ci-mode--task'}`}
          onClick={onToggleMode}
          type="button"
        >
          {mode === 'chat' ? '聊天模式' : '任务模式'}
        </button>
        <textarea
          aria-label="消息"
          className="ci-textarea"
          onChange={event => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder=""
          ref={areaRef}
          rows={1}
          value={value}
        />
        <button className="ci-send" disabled={!canSend} onClick={() => void submit()} type="button">
          {sending ? <span className="ci-ring" /> : null}
          发送
        </button>
      </div>
    </div>
  )
}
