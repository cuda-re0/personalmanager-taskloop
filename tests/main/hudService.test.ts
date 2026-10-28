import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTransport } from '../../src/main/bus'
import type { DomainEvent } from '../../src/shared/types/events'
import * as settingRepo from '../../src/main/db/repositories/settingRepo'
import * as hudService from '../../src/main/services/hudService'
import type {
  HudDisplayArea,
  HudDisplaysPort,
  HudWindowPort,
  Rect
} from '../../src/main/services/hudService'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/**
 * W9 · HUD 状态机（04 §5）。
 *
 * 全程用假窗口/假显示器端口 + 内存库：`hudService` 不 import electron 值，
 * 所以在 `ELECTRON_RUN_AS_NODE` 宿主里能直接跑。断言四件事——
 * 四形态的 bounds、边缘吸附/multi-display 回落、模式切换不重建窗口、持久化与 visible。
 */

const PRIMARY: HudDisplayArea = {
  displayId: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
}
const SECOND: HudDisplayArea = {
  displayId: 2,
  workArea: { x: 1920, y: 0, width: 1280, height: 984 }
}

function makeDisplays(areas: HudDisplayArea[]): HudDisplaysPort & { areas: HudDisplayArea[] } {
  // 方法里统一读 `port.areas`（不是闭包里的参数）：用例可以整体替换 `displays.areas`
  // 来模拟"拔掉副屏 / 分辨率变化"
  const port = {
    areas,
    workAreaOf(displayId: number | null): HudDisplayArea {
      const found =
        displayId === null ? undefined : port.areas.find(a => a.displayId === displayId)
      return found ?? port.areas[0]
    },
    nearestWorkArea(rect: Rect): HudDisplayArea {
      return (
        port.areas.find(
          a => rect.x >= a.workArea.x && rect.x < a.workArea.x + a.workArea.width
        ) ?? port.areas[0]
      )
    }
  }
  return port
}

interface FakeWindow extends HudWindowPort {
  /** 模拟用户拖动：直接改物理位置再触发 move（真实环境是 OS 移动窗口后发 move） */
  dragTo(x: number, y: number): void
  fireMove(): void
  boundsCalls: Rect[]
  movable(): boolean
}

function makeWindow(initial: Rect): FakeWindow {
  let bounds: Rect = { ...initial }
  let visible = true
  let movableValue = true
  const listeners: (() => void)[] = []
  const boundsCalls: Rect[] = []

  return {
    boundsCalls,
    movable: () => movableValue,
    getBounds: () => ({ ...bounds }),
    setBounds: rect => {
      bounds = { ...rect }
      boundsCalls.push({ ...rect })
    },
    setMovable: value => {
      movableValue = value
    },
    hide: () => {
      visible = false
    },
    showInactive: () => {
      visible = true
    },
    isVisible: () => visible,
    onMove: listener => listeners.push(listener),
    isDestroyed: () => false,
    dragTo: (x, y) => {
      bounds = { ...bounds, x, y }
    },
    fireMove: () => listeners.forEach(fn => fn())
  }
}

describe('HUD 纯几何（四形态）', () => {
  const wa = PRIMARY.workArea

  it('dock-bar：收起 32、展开 min(260, h-8)，左右各留 8px', () => {
    expect(hudService.dockBarBounds(wa, false)).toEqual({ x: 8, y: 0, width: 1904, height: 32 })
    expect(hudService.dockBarBounds(wa, true)).toEqual({ x: 8, y: 0, width: 1904, height: 260 })
    // 工作区矮于 268 时展开高度跟着缩（不超出 workArea）
    expect(hudService.dockBarBounds({ x: 0, y: 0, width: 800, height: 200 }, true).height).toBe(192)
  })

  it('float-pod 无记忆落点：右上角内缩 24px', () => {
    expect(hudService.defaultPodPoint(wa)).toEqual({ x: 1840, y: 24 })
    expect(hudService.podBounds(wa, { x: 1840, y: 24 }, false)).toEqual({
      x: 1840,
      y: 24,
      width: 56,
      height: 56
    })
  })

  it('float-pod 展开：圆在右半向左长、在左半向右长', () => {
    expect(hudService.podPanelBounds(wa, { x: 1840, y: 24 })).toEqual({
      x: 1536, // 1840 + 56 - 360
      y: 24,
      width: 360,
      height: 480
    })
    expect(hudService.podPanelBounds(wa, { x: 100, y: 24 }).x).toBe(100)
  })

  it('float-pod 展开：超出底部时向上收，整体 clamp 进 workArea', () => {
    // 24 + 480 = 504 < 1040 → 原地下沉；900 + 480 > 1040 → 底边 - 480
    expect(hudService.podPanelBounds(wa, { x: 100, y: 900 }).y).toBe(560)
    // 工作区比面板矮：高度取 workArea.height，y 被 clamp 到顶
    const short = { x: 0, y: 0, width: 800, height: 400 }
    expect(hudService.podPanelBounds(short, { x: 700, y: 300 })).toEqual({
      x: 396, // 700 + 56 - 360，仍在 workArea 内（800-360=440 的上界没碰到）
      y: 0,
      width: 360,
      height: 400
    })
  })

  it('吸附：距边 < 24 贴边/贴角，吸附后再 clamp', () => {
    expect(hudService.snapPod(wa, { x: 10, y: 500 })).toEqual({ x: 0, y: 500 })
    expect(hudService.snapPod(wa, { x: 1850, y: 500 })).toEqual({ x: 1864, y: 500 })
    expect(hudService.snapPod(wa, { x: 500, y: 5 })).toEqual({ x: 500, y: 0 })
    expect(hudService.snapPod(wa, { x: 500, y: 1000 })).toEqual({ x: 500, y: 984 })
    // 离边远：原位不动
    expect(hudService.snapPod(wa, { x: 600, y: 600 })).toEqual({ x: 600, y: 600 })
  })
})

describe('HUD 状态机（假窗口 + 假显示器 + 内存库）', () => {
  let events: DomainEvent[]

  beforeEach(() => {
    openMemoryDb()
    events = []
    setTransport(e => events.push(e))
  })

  afterEach(() => {
    hudService.detach()
    closeTestDb()
    vi.useRealTimers()
  })

  const attachDefault = (
    displays = makeDisplays([PRIMARY])
  ): { win: FakeWindow; displays: ReturnType<typeof makeDisplays> } => {
    const bounds = hudService.resolveInitialBounds(displays)
    const win = makeWindow(bounds)
    hudService.attach(win, displays)
    return { win, displays }
  }

  it('默认形态是 dock-bar 收起：贴顶、宽 workArea-16，且把回落的显示器写回', () => {
    const { win } = attachDefault()
    expect(win.getBounds()).toEqual({ x: 8, y: 0, width: 1904, height: 32 })
    expect(win.movable()).toBe(false)
    expect(settingRepo.get('hud.displayId')).toBe(1)
    expect(hudService.getState()).toEqual({
      mode: 'dock-bar',
      expanded: false,
      displayId: 1,
      visible: true
    })
  })

  it('setMode：只换 bounds 不重建窗口，并广播 hud.mode.changed；movable 随模式', () => {
    const { win } = attachDefault()
    const callsBefore = win.boundsCalls.length

    hudService.setMode('float-pod')

    expect(win.boundsCalls.length).toBe(callsBefore + 1)
    expect(win.getBounds()).toEqual({ x: 1840, y: 24, width: 56, height: 56 })
    expect(win.movable()).toBe(true)
    expect(settingRepo.get('hud.mode')).toBe('float-pod')
    expect(events.filter(e => e.type === 'hud.mode.changed')).toEqual([
      { type: 'hud.mode.changed', mode: 'float-pod' }
    ])
    // 同一个窗口对象：attach 只在建窗时调一次
    expect(hudService.getState().mode).toBe('float-pod')
  })

  it('两模式各自的展开态分别记忆（重启后恢复）', () => {
    const { win, displays } = attachDefault()
    hudService.setExpanded(true) // dock-bar 展开
    expect(win.getBounds().height).toBe(260)

    hudService.setMode('float-pod')
    // float-pod 自己那份还是 false → 56×56 圆
    expect(win.getBounds()).toEqual({ x: 1840, y: 24, width: 56, height: 56 })

    hudService.setExpanded(true)
    expect(win.getBounds()).toEqual({ x: 1536, y: 24, width: 360, height: 480 })
    expect(settingRepo.get('hud.expanded')).toEqual({ 'dock-bar': true, 'float-pod': true })

    hudService.setMode('dock-bar')
    expect(win.getBounds().height).toBe(260)

    // 重启：新窗口按 settings 还原（float-pod + 展开 + 记忆坐标）
    hudService.detach()
    const restart = makeWindow(hudService.resolveInitialBounds(displays))
    hudService.attach(restart, displays)
    expect(restart.getBounds().height).toBe(260)
    expect(hudService.getState().mode).toBe('dock-bar')
  })

  it('float-pod 记忆坐标：重启回到原位（不被默认落点覆盖）', () => {
    const { displays } = attachDefault()
    hudService.setMode('float-pod')
    hudService.moveTo(300, 400)
    expect(settingRepo.get('hud.position')).toEqual({ x: 300, y: 400 })

    hudService.detach()
    const restart = makeWindow(hudService.resolveInitialBounds(displays))
    hudService.attach(restart, displays)
    expect(restart.getBounds()).toEqual({ x: 300, y: 400, width: 56, height: 56 })
  })

  it('moveTo：clamp 进 workArea 再落库', () => {
    const { win } = attachDefault()
    hudService.setMode('float-pod')

    hudService.moveTo(5000, 5000)
    expect(win.getBounds()).toEqual({ x: 1864, y: 984, width: 56, height: 56 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1864, y: 984 })

    hudService.moveTo(-100, -100)
    expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 56, height: 56 })
  })

  it('拖动收尾：move 去抖 300ms 后才吸附 + 落库；程序化 setBounds 的回声不算拖动', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    hudService.setMode('float-pod')
    win.boundsCalls.length = 0

    // 程序化写入后由窗口回抛一条 move：位置与状态一致 → 忽略
    win.fireMove()
    vi.advanceTimersByTime(hudService.DRAG_SETTLE_MS)
    expect(win.boundsCalls.length).toBe(0)

    // 用户把圆拖到左边缘 10px 处松手
    win.dragTo(10, 700)
    win.fireMove()
    vi.advanceTimersByTime(hudService.DRAG_SETTLE_MS - 1)
    expect(win.boundsCalls.length).toBe(0) // 还没到 300ms，不认为松手

    vi.advanceTimersByTime(1)
    expect(win.getBounds()).toEqual({ x: 0, y: 700, width: 56, height: 56 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 0, y: 700 })
  })

  it('setVisible：hide/showInactive 落地，getState().visible 跟着变', () => {
    const { win } = attachDefault()
    hudService.setVisible(false)
    expect(win.isVisible()).toBe(false)
    expect(hudService.getState().visible).toBe(false)

    hudService.setVisible(true)
    expect(win.isVisible()).toBe(true)
    expect(hudService.getState().visible).toBe(true)
  })

  it('拔屏：记忆的显示器不在了 → 回落主屏顶部，不留在屏幕外', () => {
    settingRepo.set('hud.displayId', 2)
    settingRepo.set('hud.mode', 'float-pod')
    settingRepo.set('hud.position', { x: 2500, y: 300 })
    const twoScreens = makeDisplays([PRIMARY, SECOND])
    const { win } = attachDefault(twoScreens)
    expect(win.getBounds()).toEqual({ x: 2500, y: 300, width: 56, height: 56 })

    // 副屏拔掉：只剩主屏，显示器配置变化后重新 clamp
    twoScreens.areas = [PRIMARY]
    hudService.syncDisplays()

    const bounds = win.getBounds()
    expect(bounds.width).toBe(56)
    expect(bounds.x).toBeLessThanOrEqual(PRIMARY.workArea.width - 56)
    expect(settingRepo.get('hud.displayId')).toBe(1)
    expect(hudService.getState().displayId).toBe(1)
  })

  it('工作区变小（分辨率/缩放变化）：dock-bar 与 float-pod 都重新 clamp', () => {
    const displays = makeDisplays([PRIMARY])
    const { win } = attachDefault(displays)
    hudService.setMode('float-pod')
    hudService.moveTo(1800, 900)
    expect(win.getBounds()).toEqual({ x: 1800, y: 900, width: 56, height: 56 })

    displays.areas = [
      { displayId: 1, workArea: { x: 0, y: 0, width: 1280, height: 720 } }
    ]
    hudService.syncDisplays()
    expect(win.getBounds()).toEqual({ x: 1224, y: 664, width: 56, height: 56 })

    hudService.setMode('dock-bar')
    expect(win.getBounds()).toEqual({ x: 8, y: 0, width: 1264, height: 32 })
  })
})
