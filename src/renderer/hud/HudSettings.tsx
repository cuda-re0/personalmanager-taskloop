import type { ReactElement } from 'react'
import type { HudData } from './useHudData'

/**
 * 设置页（04 §5.3 v0.30，替代 v0.21 的右键菜单）。
 *
 * 只有四项，文字固定：`背景颜色` / `透明度` / `打开主界面` / `关闭悬浮窗`。
 * 不加「重置」、不加说明文字、不加图标、不加 tooltip。
 * 前两项即时生效并落库（`hud.background` / `hud.opacity`），第三项叫出主窗（v0.46），
 * 第四项只隐藏窗口。
 */

export function HudSettings({ data }: { data: HudData }): ReactElement {
  return (
    <div className="hud-settings">
      <label className="hud-field">
        <span className="hud-field-label">背景颜色</span>
        <input
          className="hud-color"
          type="color"
          value={data.background}
          onChange={e => data.actions.setBackground(e.target.value)}
        />
      </label>

      <label className="hud-field">
        <span className="hud-field-label">透明度</span>
        <input
          className="hud-range"
          type="range"
          min={0.3}
          max={1}
          step={0.05}
          value={data.opacity}
          onChange={e => data.actions.setOpacity(Number(e.target.value))}
        />
      </label>

      <button type="button" className="hud-close" onClick={() => data.actions.showMain()}>
        打开主界面
      </button>

      <button type="button" className="hud-close" onClick={() => data.actions.close()}>
        关闭悬浮窗
      </button>
    </div>
  )
}
