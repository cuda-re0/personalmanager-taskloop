import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { fmtPoints } from '@shared/format'
import type { Task } from '@shared/types/domain'
import type { EvidenceView } from '../features/chat/chatTypes'
import { TYPE_LABEL } from '../features/chat/chatViewModel'
import { EvidencePanel } from './EvidencePanel'

interface Props {
  task: Task
  /** 已转好的证据视图（附件元数据在 `useChatData` 的缓存里） */
  evidence: EvidenceView[]
  /**
   * 驳回理由（v0.41 §3）：来源是 `ChatData.needEvidenceHint[task.id]`，即该任务
   * **最近一次** `need_evidence` 审核的 `followup`。null = 没有可显示的理由，整行不进 DOM。
   * 旧审核卡被隐藏后，那句话就搬到这里，不丢。
   */
  hint: string | null
  /**
   * 未完成项清单（v0.42）：来源是 `ChatData.reviewGaps[task.id]`，即该任务**最近一条**审核消息
   * 的 `verdict.gaps`。空数组 = 没有清单，整块不进 DOM。
   */
  gaps: string[]
  /** 提交中（父层的 `submittingIds`）：两颗按钮与证据区一并禁用，不新增任何文字 */
  busy: boolean
  onPick(file: File): Promise<string | null>
  /** 失败返回 AppError.message 原文（成功为 null） */
  onCancel(): Promise<string | null>
  onSubmit(): Promise<string | null>
}

/** 卡片内错误行的停留时长（与审核卡同一个值，04 §3.2b） */
const ERROR_MS = 2600

/**
 * 04 §3.2b 待提交卡（v0.38）。
 *
 * 点完成之后、送审之前的那张卡：用户在这里交材料，再点 `[提交]` 才进审核。
 * **它是渲染层从 `status === 'pending_review'` 派生的，不是消息**——取消、提交、超时
 * 之后卡片自然消失，历史里不留痕。
 *
 * 三条写死的规则：
 * - `reason` 行只在**有驳回理由**时出现（v0.41 §3：`hint` 非空才进 DOM）。没有 AI 结论时
 *   整行不存在，也不写"请提交证据""提交后由 AI 审核"这类说明。
 * - `[提交]` 在证据数为 0 时 `disabled`（灰、点不动）。v0.39 §4：此时按钮组最左多一行
 *   无证据小字（文案见下面 `.review-actions` 里的常量分支），证据数 ≥ 1 时**不进 DOM**
 *   （不是隐藏）。禁用逻辑本身不受影响。
 * - `[取消]` 没有任何二次确认。
 */
export function SubmitCard({
  task,
  evidence,
  hint,
  gaps,
  busy,
  onPick,
  onCancel,
  onSubmit
}: Props): ReactElement {
  const [opened, setOpened] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 卡片自己的动作在飞（一次一个动作）；与父层的 busy 合成同一个禁用态
  const [localBusy, setLocalBusy] = useState(false)
  const disabled = busy || localBusy

  // 错误原文停留 2.6s；连点只重置计时，不叠多行
  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(() => setError(null), ERROR_MS)
    return () => window.clearTimeout(timer)
  }, [error])

  const runAction = (fn: () => Promise<string | null>): void => {
    if (disabled) return
    setLocalBusy(true)
    void fn()
      .then(message => {
        if (message) setError(message)
      })
      .finally(() => setLocalBusy(false))
  }

  return (
    <div className="submit-card">
      <div className="review-head">
        <span className="review-title">{task.title}</span>
        <span className="review-meta">
          {TYPE_LABEL[task.type]} · {fmtPoints(task.pointsPlanned)}分
        </span>
      </div>

      {hint ? <p className="review-reason">{hint}</p> : null}

      {gaps.length > 0 ? (
        <ul className="review-gaps">
          {gaps.map(item => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}

      <EvidencePanel
        busy={disabled}
        canAdd
        evidence={evidence}
        onOpen={setOpened}
        onPick={file => runAction(() => onPick(file))}
        openSignal={0}
      />

      <div className="review-actions">
        {evidence.length === 0 ? <span className="submit-hint">还没有证据</span> : null}
        <button
          className="btn btn--ghost"
          disabled={disabled}
          onClick={() => runAction(onCancel)}
          type="button"
        >
          取消
        </button>
        <button
          className="btn btn--primary"
          disabled={disabled || evidence.length === 0}
          onClick={() => runAction(onSubmit)}
          type="button"
        >
          提交
        </button>
      </div>

      {error !== null ? <p className="submit-error">{error}</p> : null}

      {opened ? (
        <div className="lightbox" onClick={() => setOpened(null)} role="presentation">
          <img alt="" className="lightbox-img" src={opened} />
        </div>
      ) : null}
    </div>
  )
}
