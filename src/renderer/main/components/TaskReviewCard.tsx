import { useState } from 'react'
import type { ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import type { EventResult, ReviewVerdict } from '@shared/types/domain'
import type { ChatActions, EvidenceView, ReviewView } from '../features/chat/chatTypes'
import { TYPE_LABEL, mimeExt } from '../features/chat/chatViewModel'

interface Props {
  view: ReviewView
  verdict: ReviewVerdict
  actions: ChatActions
}

/**
 * 一条证据。v0.8 起 Evidence 只有 text / attachment，
 * 截图渲染缩略图、其余附件（PDF 等）渲染成带类型角标的文件块。
 */
function EvidenceChip({
  item,
  onOpen,
  onRemove
}: {
  item: EvidenceView
  onOpen(url: string): void
  onRemove(): void
}): ReactElement {
  if (item.kind === 'attachment' && item.attachmentKind === 'image' && item.url) {
    return (
      <span className="ev-thumb">
        <img alt="" className="ev-thumb-img" onClick={() => onOpen(item.url as string)} src={item.url} />
        <button className="ev-remove" onClick={onRemove} type="button">
          ×
        </button>
      </span>
    )
  }
  return (
    <span className={`ev-text ${item.kind === 'attachment' ? 'ev-file' : ''}`}>
      <span className="ev-text-body">
        {item.kind === 'attachment' ? mimeExt(item.mime) : item.text}
      </span>
      <button className="ev-remove" onClick={onRemove} type="button">
        ×
      </button>
    </span>
  )
}

/**
 * 04 §3.3 审核卡片。左侧 3px 色条由 verdict 决定（CSS 类），
 * 四个状态的差别只在动作区：need_evidence / pass 不给直接完成的口子。
 */
export function TaskReviewCard({ view, verdict, actions }: Props): ReactElement {
  const [opened, setOpened] = useState<string | null>(null)
  const { task, planned, awarded, evidence, needEvidenceCount, result, leadLabel } = view
  const isNeed = verdict.verdict === 'need_evidence'
  // 只有 pass / partial 有 [完成 +N]，也才有分值可算
  const canComplete = verdict.verdict === 'pass' || verdict.verdict === 'partial'
  const pointsText = fmtPoints(awarded ?? planned)

  return (
    <div className={`review-card review-card--${verdict.verdict}`}>
      <div className="review-head">
        <span className="review-title">{task.title}</span>
        <span className="review-meta">
          {TYPE_LABEL[task.type]} · {fmtPoints(planned)}分
          {leadLabel ? <span className="review-lead">{leadLabel}</span> : null}
        </span>
      </div>

      <p className="review-reason">{isNeed ? (verdict.followup ?? verdict.reason) : verdict.reason}</p>

      {/* 04 §3.3：partial 时按 verdict.gaps 逐条列出未完成项，不加引导语 */}
      {verdict.gaps.length > 0 ? (
        <ul className="review-gaps">
          {verdict.gaps.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}

      <div className="review-evidence">
        <span className="review-evidence-label">证据</span>
        {evidence.map(item => (
          <EvidenceChip
            item={item}
            key={item.key}
            onOpen={setOpened}
            onRemove={() => actions.removeEvidence(task.id, item.key)}
          />
        ))}
        <button className="ev-add" onClick={() => actions.addEvidence(task.id)} type="button">
          +
        </button>
      </div>

      {/* 04 §3.3：结果档只在有 [完成 +N] 的卡上出现（pass / partial），
          fail 与 need_evidence 没有完成动作，摆个下拉改了没反应 */}
      {task.type === 'event' && result && canComplete ? (
        <div className="review-result-row">
          <select
            aria-label="结果"
            className="review-result"
            onChange={event => actions.setEventResult(task.id, event.target.value as EventResult)}
            value={result}
          >
            <option value="exceeded">超预期</option>
            <option value="met">达标</option>
            <option value="below">不佳</option>
          </select>
        </div>
      ) : null}

      <div className="review-actions">
        {isNeed ? (
          <>
            {evidence.length > 0 ? (
              <button
                className="btn btn--ghost"
                onClick={() => actions.reReview(task.id)}
                type="button"
              >
                重新审核
              </button>
            ) : null}
            <button
              className="btn btn--primary"
              onClick={() => actions.addEvidence(task.id)}
              type="button"
            >
              补证据
            </button>
          </>
        ) : null}

        {canComplete ? (
          <>
            {task.requiresEvidence ? (
              <button
                className="btn btn--ghost"
                onClick={() => actions.addEvidence(task.id)}
                type="button"
              >
                补证据
              </button>
            ) : null}
            <button
              className="btn btn--primary"
              onClick={() => actions.completeTask(task.id)}
              type="button"
            >
              完成 +{pointsText}
            </button>
          </>
        ) : null}

        <button className="btn btn--ghost" onClick={() => actions.continueTask(task.id)} type="button">
          继续做
        </button>

        {/* 连续 3 次 need_evidence 后的防死锁出口，最右、弱化（04 §3.3） */}
        {needEvidenceCount >= 3 ? (
          <button
            className="btn btn--faint"
            onClick={() => actions.markDoneWithoutPoints(task.id)}
            type="button"
          >
            直接标记完成（不计分）
          </button>
        ) : null}
      </div>

      {opened ? (
        <div className="lightbox" onClick={() => setOpened(null)} role="presentation">
          <img alt="" className="lightbox-img" src={opened} />
        </div>
      ) : null}
    </div>
  )
}
