import type { ReactElement } from 'react'
import type { NotifyPayload } from '@shared/types/ipc'

interface Props {
  payload: NotifyPayload
  /** 关掉这个窗口：轻形态点整块、重形态只有 `×` 会调它 */
  onDismiss: () => void
}

/**
 * 提醒的两个形态（v0.58，58 §3.5）。
 *
 * 文案只剩四个中文字面量：`还剩`、`限时`、`活动`、`截止`（类型标签来自 `TYPE_LABEL`）。
 * 不加"提醒""待办""知道了""点击关闭"之类——用户要的是提醒本身，不是替他把话说全。
 *
 * 动画全在 CSS 里（`notify.css` 的两个 keyframes）：组件挂载即播，
 * 窗口位置由主进程定死，动的只有内容。
 */

/**
 * 把 `1h` / `2d` / `明天` 拆成「数字 + 单位」：重窗口的大数字只放大数字部分。
 * 拆不出来（`明天` / `逾期`）就整串当数字，单位留空。
 */
function splitRemain(label: string): { value: string; unit: string } {
  const matched = /^(\d+(?:\.\d+)?)(.*)$/.exec(label)
  if (matched === null) return { value: label, unit: '' }
  return { value: matched[1], unit: matched[2] }
}

export function ReminderNotice({ payload, onDismiss }: Props): ReactElement {
  if (payload.level === 'strong') {
    const { value, unit } = splitRemain(payload.remainLabel)
    return (
      <div className="notice notice--strong">
        <span className="notice-strong-bar" />
        <div className="notice-strong-head">
          <span className="notice-strong-type">{payload.typeLabel}</span>
          <button className="notice-strong-close" onClick={onDismiss} type="button">
            ×
          </button>
        </div>
        <div className="notice-strong-title">{payload.title}</div>
        {payload.remainLabel === '' ? null : (
          <div className="notice-strong-remain">
            {value}
            {unit ? <span className="notice-strong-unit">{unit}</span> : null}
          </div>
        )}
        {payload.dueLabel === '' ? null : (
          <div className="notice-strong-due">{payload.dueLabel} 截止</div>
        )}
      </div>
    )
  }

  return (
    <div className="notice notice--light" onClick={onDismiss}>
      <span className="notice-light-bar" />
      <div className="notice-light-body">
        <div className="notice-light-title">{payload.title}</div>
        {payload.remainLabel === '' ? null : (
          <div className="notice-light-sub">还剩 {payload.remainLabel}</div>
        )}
      </div>
    </div>
  )
}
