import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Memory, MemoryKind } from '@shared/types/domain'
import {
  KIND_LABEL,
  KIND_ORDER,
  SOURCE_LABEL,
  TONE_LABEL,
  TONE_ORDER,
  canAddMemory
} from './settingsModel'
import { useSettingsData, type SettingsData } from './useSettingsData'
import './settings.css'

/**
 * 设置抽屉（v0.44，04 §2 的 [设置]，形态 = 右侧抽屉 + 遮罩压暗）。
 *
 * 职责边界：**纯展示**。数据与动作全在 `useSettingsData`，本文件不直接碰 IPC——
 * 抽屉里的每次读写都由 hook 负责（`settingsWiring.test.ts` 会盯这一条）。
 *
 * 关闭方式三种：点遮罩、点 `×`、按 `Esc`。**没有**确认、没有动画、没有 focus trap：
 * 项目没有焦点管理设施，做一半的焦点陷阱比不做更怪；关闭即卸载由调用方负责
 * （`index.tsx` 的 `{settingsOpen && …}`）。
 *
 * `Esc` 的一个坑：记忆行在编辑态时，`Esc` 只退出编辑。编辑框的 keydown 里
 * `stopPropagation()` 把事件摁住，面板根那层监听收不到，抽屉就不会被一起关掉。
 */

interface Props {
  onClose(): void
}

export function SettingsDrawer({ onClose }: Props): ReactElement {
  const data = useSettingsData()
  const panelRef = useRef<HTMLDivElement>(null)

  // 打开时焦点落在面板根（tabIndex=-1）：不打这一枪，随后的 Esc 就没有落点
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  return (
    <>
      <div className="settings-mask" onClick={onClose} />
      <div
        className="settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={event => {
          if (event.key === 'Escape') onClose()
        }}
      >
        <div className="settings-head">
          <span className="settings-title">设置</span>
          <button type="button" className="settings-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-body">
          <PersonaBlock data={data} />
          <MemoryBlock data={data} />
          <AiBlock data={data} />
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * ① 人物卡
 * ------------------------------------------------------------------ */

function PersonaBlock({ data }: { data: SettingsData }): ReactElement {
  return (
    <section className="settings-block">
      <h3 className="settings-block-title">人物卡</h3>

      <label className="settings-field">
        <span className="settings-label">名字</span>
        <input
          className="settings-input"
          maxLength={20}
          value={data.form.name}
          onChange={event => data.setField('name', event.target.value)}
        />
      </label>

      <label className="settings-field">
        <span className="settings-label">怎么称呼我</span>
        <input
          className="settings-input"
          maxLength={20}
          value={data.form.userCall}
          onChange={event => data.setField('userCall', event.target.value)}
        />
      </label>

      <label className="settings-field">
        <span className="settings-label">人设</span>
        <textarea
          className="settings-textarea"
          rows={5}
          maxLength={800}
          value={data.form.personaMd}
          onChange={event => data.setField('personaMd', event.target.value)}
        />
      </label>

      <div className="settings-field">
        <span className="settings-label">语气</span>
        <div className="settings-tones">
          {TONE_ORDER.map(tone => (
            <button
              key={tone}
              type="button"
              className="settings-tone"
              aria-pressed={data.form.tone === tone}
              onClick={() => data.setField('tone', tone)}
            >
              {TONE_LABEL[tone]}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-save-row">
        {/* 后端 message 原文，不包装成「保存失败，请重试」 */}
        {data.personaError !== null && <span className="settings-error">{data.personaError}</span>}
        {data.notice && <span className="settings-notice">已保存</span>}
        <button
          type="button"
          className="settings-save"
          disabled={!data.canSave}
          onClick={data.save}
        >
          保存
        </button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * ② 记忆
 * ------------------------------------------------------------------ */

function MemoryBlock({ data }: { data: SettingsData }): ReactElement {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [addText, setAddText] = useState('')
  const [addKind, setAddKind] = useState<MemoryKind>('profile')

  /**
   * Enter / Esc 已经决定了这一行的结局：紧随其后的 blur **不许**再保存一次。
   * 提交失败时复位成 `false`，用户还留在编辑态。
   */
  const closing = useRef(false)

  /**
   * 当前正在编辑哪一行。跟 `editingId` 同步换值，但要**在异步回调里**读它：
   * `editingId` 在 `.then` 的闭包里永远停在提交那一帧，用户中途切到另一行也看不见。
   */
  const editIdRef = useRef<string | null>(null)

  /** 稳定身份的回调 ref：只在输入框挂载那一次执行（每次渲染都换函数会让光标一直跳到尾部） */
  const focusEnd = useCallback((node: HTMLInputElement | null): void => {
    if (node === null) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])

  const endEdit = useCallback((): void => {
    closing.current = true
    editIdRef.current = null
    setEditingId(null)
    setDraft('')
  }, [])

  const beginEdit = useCallback((memory: Memory): void => {
    closing.current = false
    editIdRef.current = memory.id
    setDraft(memory.contentMd)
    setEditingId(memory.id)
  }, [])

  const commitEdit = useCallback(
    (memory: Memory): void => {
      if (closing.current) return
      const text = draft.trim()
      // 没改动、或削完是空串：直接退出，不调 IPC
      if (text === '' || text === memory.contentMd) {
        endEdit()
        return
      }
      closing.current = true
      void data.updateMemory(memory.id, text).then(ok => {
        if (ok) {
          // 只有在「此刻仍在编辑这一行」时才收尾：用户可能已经切去改另一行了，
          // 无条件 endEdit 会把那一行的编辑态一起清掉（清的是全局 editingId / draft）
          if (editIdRef.current === memory.id) endEdit()
          return
        }
        // 失败：留在编辑态让用户改，错误原文显示在块底
        closing.current = false
      })
    },
    [draft, data, endEdit]
  )

  const submitAdd = useCallback((): void => {
    if (!canAddMemory(addText)) return
    void data.addMemory(addText, addKind).then(ok => {
      if (ok) setAddText('')
    })
  }, [addText, addKind, data])

  return (
    <section className="settings-block">
      <h3 className="settings-block-title">记忆</h3>

      {/* 顺序照后端给的来（`memory.list()` 已按 updatedAt 降序），前端不重排；空列表什么都不渲染 */}
      <div className="settings-memories">
        {data.memories.map(memory => (
          <div className="settings-memory-row" key={memory.id}>
            {editingId === memory.id ? (
              <input
                className="settings-memory-input"
                maxLength={120}
                value={draft}
                ref={focusEnd}
                onChange={event => setDraft(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitEdit(memory)
                  } else if (event.key === 'Escape') {
                    event.stopPropagation()
                    endEdit()
                  }
                }}
                onBlur={() => {
                  if (closing.current) {
                    closing.current = false
                    return
                  }
                  commitEdit(memory)
                }}
              />
            ) : (
              <button
                type="button"
                className="settings-memory-text"
                onClick={() => beginEdit(memory)}
              >
                {memory.contentMd}
              </button>
            )}
            <span className="settings-badge">
              {KIND_LABEL[memory.kind]} · {SOURCE_LABEL[memory.source]}
            </span>
            <button
              type="button"
              className="settings-del"
              disabled={data.busyId === memory.id}
              onClick={() => data.removeMemory(memory.id)}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      <div className="settings-add-row">
        <input
          className="settings-input"
          maxLength={120}
          aria-label="新的记忆"
          value={addText}
          onChange={event => setAddText(event.target.value)}
        />
        <select
          className="settings-select"
          aria-label="记忆类型"
          value={addKind}
          onChange={event => setAddKind(event.target.value as MemoryKind)}
        >
          {KIND_ORDER.map(kind => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="settings-add"
          disabled={!canAddMemory(addText)}
          onClick={submitAdd}
        >
          添加
        </button>
      </div>

      {/* 撞 50 条上限、内容重复之类都由后端说话，这里只原样显示 */}
      {data.memoryError !== null && (
        <div className="settings-error settings-error--block">{data.memoryError}</div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * ③ AI（三行只读，没有输入框、没有修改入口）
 * ------------------------------------------------------------------ */

function AiBlock({ data }: { data: SettingsData }): ReactElement {
  // 还没拿到 keyStatus 时留空——不猜「未配置」，那是在说一个我们还没问过的答案
  let keyText = ''
  if (data.configured !== null) keyText = data.configured ? '已配置' : '未配置'

  return (
    <section className="settings-block">
      <h3 className="settings-block-title">AI</h3>

      <div className="settings-kv">
        <span className="settings-kv-key">任务模型</span>
        <span className="settings-kv-value">{data.models.task}</span>
      </div>
      <div className="settings-kv">
        <span className="settings-kv-key">聊天模型</span>
        <span className="settings-kv-value">{data.models.chat}</span>
      </div>
      <div className="settings-kv">
        <span className="settings-kv-key">API Key</span>
        <span className="settings-kv-value">{keyText}</span>
      </div>

      {data.aiError !== null && (
        <div className="settings-error settings-error--block">{data.aiError}</div>
      )}
    </section>
  )
}
