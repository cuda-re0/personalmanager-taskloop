import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import type { ReviewVerdict } from '@shared/types/domain'
import type { ChatActions, ReviewView } from '../features/chat/chatTypes'
import { TYPE_LABEL } from '../features/chat/chatViewModel'
import { EvidencePanel } from './EvidencePanel'

interface Props {
  view: ReviewView
  verdict: ReviewVerdict
  actions: ChatActions
}

/** 卡片内错误行的停留时长（与 ① 的行内红字同一个值，04 §3.3） */
const ERROR_MS = 2600

/**
 * 04 §3.3 审核卡片（v0.35 / v0.36 重排）。
 *
 * v0.34 起审核是「提交即送审 + 按 verdict 自动流转」，所以卡片出现时任务早已不在原状态：
 * `pass` 已计分落库、`partial` / `fail` 已回 `doing` 或判 `missed`。因此**只有
 * `need_evidence`（且是该任务最新一张卡）带按钮**：`[补证据]`（无证据时）/
 * `[重新审核]` + `[补证据]`（已有证据）；连续 3 次 need_evidence 后再加一颗弱化的
 * `[直接标记完成（不计分）]` 作防死锁出口。
 *
 * 已删：「完成 +N」（自动完成后会撞 CONFLICT）、「继续做」（在 done 上点等于把任务拉回
 * doing 却留着分）、活动结果档下拉（自动完成后没有修改窗口）。
 */
export function TaskReviewCard({ view, verdict, actions }: Props): ReactElement {
  const [opened, setOpened] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openSignal, setOpenSignal] = useState(0)
  // v0.74：说明输入口。只给可动作的卡——旧卡只读，写了也只有一张不会被重审的证据
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const { task, planned, evidence, needEvidenceCount, leadLabel, isLatest } = view
  const isNeed = verdict.verdict === 'need_evidence'
  // 旧卡只读：同一任务补证据后重审会产生新的一条消息，旧卡若还能点会连发多份请求
  const actionable = isNeed && isLatest && task.status === 'reviewing'
  // 证据入口的开关只看任务状态（36 §8）：驳回后任务回 doing，审核卡是补材料的唯一入口，
  // 所以 doing 必须在允许集合里；done / missed / discarded / archived 一颗加号都不留。
  const canAdd =
    task.status === 'todo' ||
    task.status === 'doing' ||
    task.status === 'pending_review' ||
    task.status === 'reviewing'

  // 错误原文停留 2.6s；连点只重置计时，不叠加多行
  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(() => setError(null), ERROR_MS)
    return () => window.clearTimeout(timer)
  }, [error])

  // v0.57：返回值可 await——证据区多文件拖放要串行，`undefined` 会让 await 立即通过
  const runAction = (fn: () => Promise<string | null>): Promise<void> => {
    if (busy) return Promise.resolve()
    setBusy(true)
    return fn()
      .then(message => {
        if (message) setError(message)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className={`review-card review-card--${verdict.verdict}`}>
      <div className="review-head">
        <span className="review-title">{task.title}</span>
        <span className="review-meta">
          {TYPE_LABEL[task.type]} · {fmtPoints(planned)}分
          {leadLabel ? <span className="review-lead">{leadLabel}</span> : null}
        </span>
      </div>

      {/* need_evidence 的追问优先用 followup（AI 要求补什么），其余 verdict 原样显示 reason */}
      <p className="review-reason">{isNeed ? (verdict.followup ?? verdict.reason) : verdict.reason}</p>

      {/* 04 §3.3：partial 时按 verdict.gaps 逐条列出未完成项，不加引导语 */}
      {verdict.gaps.length > 0 ? (
        <ul className="review-gaps">
          {verdict.gaps.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}

      <EvidencePanel
        busy={busy}
        canAdd={canAdd}
        evidence={evidence}
        onOpen={setOpened}
        onPick={file => runAction(() => actions.addEvidence(task.id, file))}
        openSignal={openSignal}
      />

      {noteOpen ? (
        <div className="note-editor">
          <textarea
            autoFocus
            className="note-input"
            maxLength={200}
            onChange={event => setNote(event.target.value)}
            placeholder="写一句说明"
            rows={2}
            value={note}
          />
          <div className="note-actions">
            <button
              className="btn btn--ghost"
              onClick={() => {
                setNoteOpen(false)
                setNote('')
              }}
              type="button"
            >
              取消
            </button>
            <button
              className="btn btn--primary"
              disabled={busy || note.trim().length === 0}
              onClick={() =>
                void runAction(async () => {
                  const message = await actions.addTextEvidence(task.id, note)
                  // 成功才收起；失败保持打开且不清空——用户刚写的字不能丢
                  if (message === null) {
                    setNote('')
                    setNoteOpen(false)
                  }
                  return message
                })
              }
              type="button"
            >
              确认
            </button>
          </div>
        </div>
      ) : null}

      {actionable ? (
        <div className="review-actions">
          {/* v0.74：说明入口只在 actionable 卡上；旧卡不给，写了也不会重审 */}
          <button
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => {
              setNoteOpen(true)
            }}
            type="button"
          >
            写说明
          </button>
          {/* v0.38 §8：need_evidence 卡加 [取消] —— 回 doing，不发分（v0.74 起左边多一颗 [写说明]） */}
          <button
            className="btn btn--ghost"
            disabled={busy}
            onClick={() => runAction(() => actions.cancelSubmit(task.id))}
            type="button"
          >
            取消
          </button>
          {evidence.length > 0 ? (
            <button
              className="btn btn--ghost"
              disabled={busy}
              onClick={() => runAction(() => actions.reReview(task.id))}
              type="button"
            >
              重新审核
            </button>
          ) : null}
          <button
            className="btn btn--primary"
            disabled={busy}
            onClick={() => setOpenSignal(n => n + 1)}
            type="button"
          >
            补证据
          </button>
          {/* 连续 3 次 need_evidence 后的防死锁出口，最右、弱化（04 §3.3） */}
          {needEvidenceCount >= 3 ? (
            <button
              className="btn btn--faint"
              disabled={busy}
              onClick={() => runAction(() => actions.markDoneWithoutPoints(task.id))}
              type="button"
            >
              直接标记完成（不计分）
            </button>
          ) : null}
        </div>
      ) : null}

      {error !== null ? <p className="review-error">{error}</p> : null}

      {opened
        ? createPortal(
            <div className="lightbox" onClick={() => setOpened(null)} role="presentation">
              <img alt="" className="lightbox-img" src={opened} />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
