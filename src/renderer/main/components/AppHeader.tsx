import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'

/**
 * 主窗顶栏（04 §2，56px）：左 应用名、右 [悬浮条开关] [设置]。
 *
 * 开关只做显隐：不带可见文字（用 `role="switch"` + `aria-label`），
 * 界面文案纪律见 04 §1：`aria-label` 允许，可见文字只许已登记的串。
 *
 * v0.44：04 §2 图里的 [设置] 已点亮（右侧抽屉，见 `features/settings/SettingsDrawer`）。
 * 本文件不碰开关逻辑，只多一个 `onOpenSettings` 回调给抽屉开门。
 *
 * 初态取 `hud.getState().visible`（v0.17 新增字段），此后以本地状态为准做切换；
 * v0.31 起主进程 `hud.setVisible()` 会广播 `hud.visible.changed`（HUD 设置页「关闭悬浮窗」
 * 也走这条），所以再订阅一次把本地状态拉回真值——否则开关会停在"开"，点第一次没反应。
 */

const HEADER_HEIGHT = 56

const headerStyle: CSSProperties = {
  display: 'flex',
  flex: `0 0 ${HEADER_HEIGHT}px`,
  alignItems: 'center',
  justifyContent: 'space-between',
  height: HEADER_HEIGHT,
  boxSizing: 'border-box',
  padding: '0 16px',
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  fontFamily: 'var(--font)',
  fontSize: 14
}

/** 右侧两个控件，间距 12px（04 §2 图） */
const rightGroupStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12
}

/** 设置按钮：无边框、透明底、--text-sub 字 13px；hover 换底与字色（无 CSS 文件可用，就地给） */
const settingsButtonStyle: CSSProperties = {
  padding: '4px 10px',
  border: 'none',
  borderRadius: 'var(--r-sm)',
  background: 'transparent',
  color: 'var(--text-sub)',
  fontFamily: 'var(--font)',
  fontSize: 13,
  cursor: 'pointer'
}

interface Props {
  onOpenSettings: () => void
}

export function AppHeader({ onOpenSettings }: Props): ReactElement {
  // null = 还没拿到初态：先按"显示"画，避免闪一下关闭态
  const [visible, setVisible] = useState<boolean | null>(null)
  const [settingsHover, setSettingsHover] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.hud
      .getState()
      .then(res => {
        if (!alive) return
        if (!res.ok) {
          console.error('[header] hud.getState 失败', res.error)
          return
        }
        setVisible(res.data.visible)
      })
      .catch((e: unknown) => console.error('[header] hud.getState 调用失败', e))
    return () => {
      alive = false
    }
  }, [])

  const on = visible !== false

  // HUD 侧（设置页「关闭悬浮窗」）改了显隐：跟主进程的广播走，不让开关与真值脱钩。
  // 回调里只读——写回 `hud.setVisible` 会自激（广播 → 再 setVisible → 再广播）。
  useEffect(() => {
    const off = window.api.onEvent(event => {
      if (event.type === 'hud.visible.changed') setVisible(event.visible)
    })
    return off
  }, [])

  const toggle = (): void => {
    const next = !on
    setVisible(next)
    void window.api.hud
      .setVisible({ visible: next })
      .then(res => {
        if (!res.ok) {
          console.error('[header] hud.setVisible 失败', res.error)
          setVisible(!next) // 没生效就别骗自己：开关回弹到真实状态
        }
      })
      .catch((e: unknown) => {
        console.error('[header] hud.setVisible 调用失败', e)
        setVisible(!next)
      })
  }

  return (
    <header style={headerStyle}>
      <span>taskloop</span>
      <div style={rightGroupStyle}>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="悬浮条开关"
          onClick={toggle}
          style={{
            position: 'relative',
            width: 36,
            height: 20,
            padding: 0,
            border: 'none',
            borderRadius: 10,
            background: on ? 'var(--accent)' : 'var(--border)',
            cursor: 'pointer',
            transition: 'background 150ms'
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: on ? 18 : 2,
              width: 16,
              height: 16,
              borderRadius: 8,
              background: '#ffffff',
              transition: 'left 150ms'
            }}
          />
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          onMouseEnter={() => setSettingsHover(true)}
          onMouseLeave={() => setSettingsHover(false)}
          style={
            settingsHover
              ? { ...settingsButtonStyle, background: 'var(--bg-hover)', color: 'var(--text)' }
              : settingsButtonStyle
          }
        >
          设置
        </button>
      </div>
    </header>
  )
}
