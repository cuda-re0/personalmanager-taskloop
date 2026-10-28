import { useState, type ReactElement } from 'react'
import type { HudData } from './useHudData'
import type { HudRow } from './hudModel'
import { ratioLabel, todayPointsLabel } from './hudModel'

/**
 * 两种形态共用的内容面板（04 §5：一套 `HudPanel`，外壳不同）。
 *
 * 文案纪律（红线 5）：面板上只有三类东西——
 * `● 3/5`、`今日 +42`、任务标题；出错时多一条 `AppError.message` 原样。
 * 不写"暂无任务""点击展开"这类旁白。
 */

interface HudPanelProps {
  data: HudData
  /** `bar` = 顶部贴边条（宽、矮）；`panel` = float-pod 展开面板（360×480） */
  variant: 'bar' | 'panel'
}

function HudRowItem({
  row,
  onComplete
}: {
  row: HudRow
  onComplete(row: HudRow): void
}): ReactElement {
  return (
    <li className="hud-row">
      <button
        type="button"
        className={row.done ? 'hud-check is-done' : 'hud-check'}
        onClick={() => onComplete(row)}
        disabled={row.done}
        aria-label={row.title}
        aria-pressed={row.done}
      />
      <span className={row.done ? 'hud-row-title is-done' : 'hud-row-title'}>{row.title}</span>
    </li>
  )
}

/** 一句话加任务：`task.createManual`（deadline / medium / 无 due_at），回车提交 */
function HudAddTask({ onAdd }: { onAdd: (title: string) => Promise<boolean> }): ReactElement {
  const [value, setValue] = useState('')

  const submit = (): void => {
    if (value.trim().length === 0) return
    void onAdd(value).then(ok => {
      if (ok) setValue('')
    })
  }

  return (
    <div className="hud-add">
      <input
        className="hud-input"
        value={value}
        placeholder="一句话加任务…"
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />
    </div>
  )
}

export function HudPanel({ data, variant }: HudPanelProps): ReactElement {
  return (
    <div
      className={`hud-panel hud-panel--${variant}${data.expanded ? ' is-open' : ''}`}
    >
      <div className="hud-head">
        <span className="hud-ratio">
          <span className="hud-dot" aria-hidden="true" />
          {ratioLabel(data.done, data.total)}
        </span>
        <span className="hud-points">{todayPointsLabel(data.points)}</span>
        <span className="hud-grow" />
        {variant === 'bar' && data.recentTitle ? (
          <span className="hud-recent">{data.recentTitle}</span>
        ) : null}
        <button
          type="button"
          className="hud-mode"
          onClick={() => data.actions.switchMode()}
          aria-label="切换悬浮形态"
        >
          ⋯
        </button>
      </div>

      {data.expanded ? (
        <>
          <ul className="hud-list">
            {data.rows.map(row => (
              <HudRowItem key={`${row.kind}:${row.id}`} row={row} onComplete={data.actions.completeRow} />
            ))}
          </ul>
          <HudAddTask onAdd={data.actions.addTask} />
        </>
      ) : null}

      {data.error ? <div className="hud-tip">{data.error}</div> : null}
    </div>
  )
}
