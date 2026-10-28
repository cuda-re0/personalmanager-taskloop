import { useState } from 'react'
import type { ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import { ALLOWED_DIFFICULTIES } from '@shared/taskRules'
import type { Difficulty } from '@shared/types/domain'
import type { ChatActions, DraftPatch, DraftView } from '../features/chat/chatTypes'
import { MarkdownText } from '../features/chat/MarkdownText'
import {
  DIFFICULTY_LABEL,
  TYPE_LABEL,
  TYPE_ORDER,
  localToDueHint,
  reminderSummary
} from '../features/chat/chatViewModel'

interface Props {
  view: DraftView
  actions: ChatActions
}

/** 04 §3.2 草稿卡片。分值由外部算好传入，本组件不碰公式。 */
export function TaskDraftCard({ view, actions }: Props): ReactElement {
  const { draft, dueLocal, confirmedTaskId } = view
  const confirmed = confirmedTaskId !== null
  const [expanded, setExpanded] = useState(false)

  const patch = (next: DraftPatch): void => {
    if (confirmed) return
    actions.patchDraft(draft.localId, next)
  }

  const summary = reminderSummary(draft.type, draft.dailyTimeHint, draft.reminderOffsets)

  return (
    <div
      className={[
        'draft-card',
        draft.confidence < 0.5 ? 'draft-card--low' : '',
        confirmed ? 'draft-card--confirmed' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="draft-types">
        {TYPE_ORDER.map(type => (
          <button
            aria-pressed={draft.type === type}
            className={`draft-type ${draft.type === type ? 'draft-type--on' : ''}`}
            disabled={confirmed}
            key={type}
            onClick={() => patch({ type })}
            type="button"
          >
            {TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      <div className="draft-title-row">
        <input
          aria-label="标题"
          className="draft-title"
          disabled={confirmed}
          onChange={event => patch({ title: event.target.value })}
          value={draft.title}
        />
        <span className="draft-points">+{fmtPoints(draft.pointsPlanned)}</span>
      </div>

      {draft.detailMd ? (
        <div
          className={`draft-detail ${expanded ? '' : 'draft-detail--clamp'}`}
          onClick={() => setExpanded(value => !value)}
          role="presentation"
        >
          <MarkdownText text={draft.detailMd} />
        </div>
      ) : null}

      {draft.steps.length > 0 ? (
        <ul className="draft-steps">
          {draft.steps.map(step => (
            <li key={step.localId}>
              <span className="draft-step-dot" />
              {step.title}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="draft-fields">
        <label className="draft-field">
          <span className="draft-field-label">难度</span>
          <select
            aria-label="难度"
            className="draft-select"
            disabled={confirmed}
            onChange={event => patch({ difficulty: event.target.value as Difficulty })}
            value={draft.difficulty}
          >
            {ALLOWED_DIFFICULTIES[draft.type].map(item => (
              <option key={item} value={item}>
                {DIFFICULTY_LABEL[item]}
              </option>
            ))}
          </select>
        </label>

        <div className="draft-field">
          <input
            aria-label="时长"
            className="draft-num"
            disabled={confirmed}
            min={0}
            onChange={event =>
              patch({ estimateMin: event.target.value === '' ? null : Number(event.target.value) })
            }
            step={5}
            type="number"
            value={draft.estimateMin ?? ''}
          />
          <span className="draft-field-label">分钟</span>
        </div>

        {draft.type === 'daily' ? (
          <>
            <input
              aria-label="每日时刻"
              className="draft-time"
              disabled={confirmed}
              onChange={event => patch({ dailyTimeHint: event.target.value || null })}
              type="time"
              value={draft.dailyTimeHint ?? ''}
            />
            {/* 04 §3.2：每日任务的可选结束日期（activeToHint） */}
            <input
              aria-label="结束日期"
              className="draft-time draft-time--date"
              disabled={confirmed}
              onChange={event => patch({ activeToHint: event.target.value || null })}
              type="date"
              value={draft.activeToHint ?? ''}
            />
          </>
        ) : (
          <input
            aria-label="时间"
            className="draft-time"
            disabled={confirmed}
            onChange={event => patch({ dueHint: localToDueHint(event.target.value) })}
            type="datetime-local"
            value={dueLocal}
          />
        )}

        {confirmed ? null : (
          <div className="draft-actions">
            <button
              className="btn btn--ghost"
              onClick={() => actions.rejectDraft(draft.localId)}
              type="button"
            >
              丢弃
            </button>
            <button
              className="btn btn--primary"
              onClick={() => actions.confirmDraft(draft.localId)}
              type="button"
            >
              确认
            </button>
          </div>
        )}
      </div>

      {summary ? <div className="draft-reminders">{summary}</div> : null}

      {draft.missingInfo.length > 0 ? (
        <div className="draft-missing">
          <span className="draft-missing-label">待补</span>
          {draft.missingInfo.map(item => (
            <span className="chip" key={item}>
              {item}
            </span>
          ))}
        </div>
      ) : null}

      {confirmedTaskId ? <div className="draft-linked">{confirmedTaskId}</div> : null}
    </div>
  )
}
