import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { HudRow } from './hudModel'
import { ratioLabel, todayPointsLabel } from './hudModel'
import { HudSettings } from './HudSettings'
import type { HudData } from './useHudData'

/**
 * 面板态（04 §5.2 / §5.3 v0.30）：头部 + 两页（今天 / 设置）。
 *
 * 文案纪律（红线 5，本节即白名单）：`● N/M`、`今日 +N`、`今天`、`设置`、
 * `背景颜色`、`透明度`、`关闭悬浮窗`、任务标题、错误原文。**别的一个字都不许加**——
 * 不写空态文字、不加 tooltip、不加说明行。
 *
 * 几何纪律：窗口尺寸由主进程 `setBounds` / 用户拉伸决定，这里一律 `width/height: 100%`，
 * 不用 CSS 改窗口大小（04 §5）。
 *
 * 拖动把手 = 整个头部（`.hud-head` 是 `-webkit-app-region: drag`），
 * 头部里的 tab、列表、输入、设置控件一律 `no-drag`，否则点不动。
 */

type HudTab = 'today' | 'settings'

function HudRowItem({
  row,
  error,
  onComplete
}: {
  row: HudRow
  error: string | null
  onComplete(row: HudRow): void
}): ReactElement {
  return (
    <li className="hud-row-item">
      <div className="hud-row">
        <button
          type="button"
          className={row.done ? 'hud-check is-done' : 'hud-check'}
          onClick={() => onComplete(row)}
          disabled={row.done}
          aria-label={row.title}
          aria-pressed={row.done}
        />
        <span className={row.done ? 'hud-row-title is-done' : 'hud-row-title'}>{row.title}</span>
      </div>
      {error ? <div className="hud-row-error">{error}</div> : null}
    </li>
  )
}

/** 一句话加任务：列表下方的一行普通输入（`task.createManual`，回车或按钮提交） */
function HudAddTask({
  error,
  onAdd
}: {
  error: string | null
  onAdd: (title: string) => Promise<boolean>
}): ReactElement {
  const [value, setValue] = useState('')

  const submit = (): void => {
    if (value.trim().length === 0) return
    void onAdd(value).then(ok => {
      if (ok) setValue('')
    })
  }

  return (
    <div className="hud-add">
      <div className="hud-add-line">
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
        <button type="button" className="hud-add-submit" onClick={submit} aria-label="加任务">
          ＋
        </button>
      </div>
      {error ? <div className="hud-row-error">{error}</div> : null}
    </div>
  )
}

export function HudPanel({ data }: { data: HudData }): ReactElement {
  const [tab, setTab] = useState<HudTab>('today')
  const setMode = data.actions.setMode

  // ESC 收回球（04 §5.2 第 1 条）：挂在 window 上，输入框里按 ESC 也算收回
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMode('ball')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setMode])

  /** 行内红字只给命中的那一条（`AppError.message` 原样，4s 消失由 hook 管） */
  const rowErrorFor = (rowId: string): string | null =>
    data.rowError && data.rowError.rowId === rowId ? data.rowError.message : null

  return (
    <div className="hud-panel" style={{ '--hud-bg': data.hudBg } as CSSProperties}>
      <div className="hud-head">
        <span className="hud-ratio">
          <span className="hud-dot" aria-hidden="true" />
          {ratioLabel(data.done, data.total)}
        </span>
        <span className="hud-points">{todayPointsLabel(data.points)}</span>
        <span className="hud-grow" />
        <div className="hud-tabs">
          <button
            type="button"
            className={tab === 'today' ? 'hud-tab is-active' : 'hud-tab'}
            onClick={() => setTab('today')}
          >
            今天
          </button>
          <button
            type="button"
            className={tab === 'settings' ? 'hud-tab is-active' : 'hud-tab'}
            onClick={() => setTab('settings')}
          >
            设置
          </button>
        </div>
      </div>

      {tab === 'today' ? (
        <>
          <ul className="hud-list">
            {data.rows.map(row => (
              <HudRowItem
                key={`${row.kind}:${row.id}`}
                row={row}
                error={rowErrorFor(row.id)}
                onComplete={data.actions.completeRow}
              />
            ))}
          </ul>
          <HudAddTask error={rowErrorFor('add')} onAdd={data.actions.addTask} />
        </>
      ) : (
        <HudSettings data={data} />
      )}
    </div>
  )
}
