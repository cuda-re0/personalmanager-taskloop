import { useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from 'react'
import type { Attachment } from '@shared/types/domain'

const MAX_LINES = 6
const LINE_HEIGHT = 22
const MAX_HEIGHT = MAX_LINES * LINE_HEIGHT

interface Props {
  sending: boolean
  onSend(text: string, attachments: Attachment[]): void
}

let localSeq = 0

function toAttachment(file: File): Attachment {
  localSeq += 1
  return {
    id: `local-att-${localSeq}`,
    kind: file.type.startsWith('image/') ? 'image' : 'file',
    url: URL.createObjectURL(file),
    mime: file.type,
    bytes: file.size,
    width: null,
    height: null
  }
}

/** 04 §3.4 输入区：1~6 行自适应、Enter 发送 / Shift+Enter 换行、粘贴与拖入图、发送中禁用 */
export function ChatInput({ sending, onSend }: Props): ReactElement {
  const [value, setValue] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
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

  const canSend = !sending && (value.trim().length > 0 || files.length > 0)

  const submit = (): void => {
    if (!canSend) return
    onSend(value, files)
    setValue('')
    setFiles([])
    areaRef.current?.focus()
  }

  const addFiles = (list: FileList | File[]): void => {
    const next = Array.from(list).map(toAttachment)
    if (next.length === 0) return
    setFiles(prev => [...prev, ...next])
  }

  const removeFile = (id: string): void => {
    setFiles(prev => {
      const target = prev.find(item => item.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter(item => item.id !== id)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
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
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files)
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
          {files.map(file =>
            file.kind === 'image' ? (
              <span className="ci-thumb" key={file.id}>
                <img alt="" className="ci-thumb-img" src={file.url} />
                <button className="ci-thumb-remove" onClick={() => removeFile(file.id)} type="button">
                  ×
                </button>
              </span>
            ) : (
              <span className="ci-file" key={file.id}>
                <span className="ci-file-name">{file.mime || 'file'}</span>
                <button className="ci-thumb-remove" onClick={() => removeFile(file.id)} type="button">
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
        <button className="ci-send" disabled={!canSend} onClick={submit} type="button">
          {sending ? <span className="ci-ring" /> : null}
          发送
        </button>
      </div>
    </div>
  )
}
