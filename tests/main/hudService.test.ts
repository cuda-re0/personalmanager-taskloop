import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTransport } from '../../src/main/bus'
import type { DomainEvent } from '../../src/shared/types/events'
import type { HudMode } from '../../src/shared/types/ipc'
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
 * W9 · HUD 状态机（04 §5 v0.30：球 + 可拉伸面板）。
 *
 * 全程用假窗口/假显示器端口 + 内存库：`hudService` 不 import electron 值，
 * 所以在 `ELECTRON_RUN_AS_NODE` 宿主里能直接跑。断言五件事——
 * 几何（球/面板/展开落点）、实时变形的三条滞回区间、回声抑制（防自循环）、
 * 位置与尺寸的记忆、拔屏回落。
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
      const found = displayId === null ? undefined : port.areas.find(a => a.displayId === displayId)
      return found ?? port.areas[0]
    },
    nearestWorkArea(rect: Rect): HudDisplayArea {
      return (
        port.areas.find(a => rect.x >= a.workArea.x && rect.x < a.workArea.x + a.workArea.width) ??
        port.areas[0]
      )
    }
  }
  return port
}

interface FakeWindow extends HudWindowPort {
  /** 模拟用户拖动：直接改物理位置（不发 move，由用例显式 fireMove） */
  dragTo(x: number, y: number): void
  /** 模拟用户拉伸右下角：直接改尺寸（不发 resize） */
  resizeTo(width: number, height: number): void
  fireMove(): void
  fireResize(): void
  /** 模拟分数缩放（150%）下 setBounds 回读差 1–2px（宽高也可带偏移） */
  setDpiOffset(x: number, y: number, width?: number, height?: number): void
  boundsCalls: Rect[]
  movable(): boolean
  resizable(): boolean
  minSize(): [number, number]
  maxSize(): [number, number]
}

function makeWindow(initial: Rect): FakeWindow {
  let bounds: Rect = { ...initial }
  let visible = true
  let movableValue = true
  let resizableValue = false
  let minSize: [number, number] = [0, 0]
  let maxSize: [number, number] = [0, 0]
  let dpiOffset = { x: 0, y: 0, width: 0, height: 0 }
  const moveListeners: (() => void)[] = []
  const resizeListeners: (() => void)[] = []
  const boundsCalls: Rect[] = []

  return {
    boundsCalls,
    movable: () => movableValue,
    resizable: () => resizableValue,
    minSize: () => minSize,
    maxSize: () => maxSize,
    getBounds: () => ({
      x: bounds.x + dpiOffset.x,
      y: bounds.y + dpiOffset.y,
      width: bounds.width + dpiOffset.width,
      height: bounds.height + dpiOffset.height
    }),
    setDpiOffset: (x, y, width = 0, height = 0) => {
      dpiOffset = { x, y, width, height }
    },
    setBounds: rect => {
      bounds = { ...rect }
      boundsCalls.push({ ...rect })
    },
    setMovable: value => {
      movableValue = value
    },
    setResizable: value => {
      resizableValue = value
    },
    setMinSize: (width, height) => {
      minSize = [width, height]
    },
    setMaxSize: (width, height) => {
      maxSize = [width, height]
    },
    hide: () => {
      visible = false
    },
    showInactive: () => {
      visible = true
    },
    isVisible: () => visible,
    onMove: listener => {
      moveListeners.push(listener)
    },
    onResize: listener => {
      resizeListeners.push(listener)
    },
    isDestroyed: () => false,
    dragTo: (x, y) => {
      bounds = { ...bounds, x, y }
    },
    resizeTo: (width, height) => {
      bounds = { ...bounds, width, height }
    },
    fireMove: () => moveListeners.forEach(fn => fn()),
    fireResize: () => resizeListeners.forEach(fn => fn())
  }
}

describe('HUD 纯几何（长条 / 面板 / 展开落点）', () => {
  const wa = PRIMARY.workArea

  it('首次启动的长条位：贴右边缘（x = right − 132）、距顶 = 工作区高度 × 0.1', () => {
    expect(hudService.initialBallPoint(wa)).toEqual({ x: 1788, y: 104 })
    expect(hudService.ballBounds(wa, { x: 1788, y: 104 })).toEqual({
      x: 1788,
      y: 104,
      width: 132,
      height: 40
    })
  })

  it('长条的 x/y 都 clamp 进工作区（自由拖动，不锁边）', () => {
    expect(hudService.clampBallPoint(wa, { x: -100, y: -100 })).toEqual({ x: 0, y: 0 })
    expect(hudService.clampBallPoint(wa, { x: 9999, y: 9999 })).toEqual({ x: 1788, y: 1000 })
    expect(hudService.clampBallPoint(wa, { x: 800, y: 500 })).toEqual({ x: 800, y: 500 })
  })

  it('展开落点：右半屏以长条右边缘为基准向左长，左半屏向右长', () => {
    // 贴右边缘的长条：1788 + 132 − 360 = 1560（正好贴住右边缘，不再内缩）
    expect(
      hudService.peekPanelBounds(wa, { x: 1788, y: 104 }, hudService.DEFAULT_PANEL_SIZE)
    ).toEqual({ x: 1560, y: 104, width: 360, height: 480 })
    expect(
      hudService.peekPanelBounds(wa, { x: 100, y: 104 }, hudService.DEFAULT_PANEL_SIZE)
    ).toEqual({ x: 100, y: 104, width: 360, height: 480 })
  })

  it('展开落点完全在屏内（出屏 = 0，所以不会触发「出屏 >1/3 收长条」）', () => {
    for (const x of [0, 132, 200, 900, 1788]) {
      const rect = hudService.peekPanelBounds(wa, { x, y: 300 }, hudService.DEFAULT_PANEL_SIZE)
      expect(hudService.offscreenOf(wa, rect)).toEqual({ left: 0, right: 0 })
    }
  })

  it('收长条贴边：左/右两条边，纵向沿用面板顶并 clamp', () => {
    expect(
      hudService.ballFromPanel(wa, { x: 10, y: 300, width: 360, height: 480 }, 'left')
    ).toEqual({
      x: 0,
      y: 300
    })
    expect(
      hudService.ballFromPanel(wa, { x: 1500, y: 300, width: 360, height: 480 }, 'right')
    ).toEqual({ x: 1788, y: 300 })
    // 面板顶靠近底部（1020 + 40 > 1040）→ 收长条时纵向 clamp 回来
    expect(
      hudService.ballFromPanel(wa, { x: 10, y: 1020, width: 360, height: 40 }, 'left')
    ).toEqual({
      x: 0,
      y: 1000
    })
  })

  it('尺寸夹到 280×320 – 720×900，并适配工作区', () => {
    expect(hudService.clampSize({ width: 100, height: 100 })).toEqual({ width: 280, height: 320 })
    expect(hudService.clampSize({ width: 9999, height: 9999 })).toEqual({ width: 720, height: 900 })
    expect(hudService.fitSize(wa, { width: 500, height: 600 })).toEqual({ width: 500, height: 600 })
    // 工作区比最小尺寸还小：只能取工作区（总比被窗口裁切好）
    expect(
      hudService.fitSize({ x: 0, y: 0, width: 240, height: 300 }, { width: 360, height: 480 })
    ).toEqual({ width: 240, height: 300 })
  })

  it('透明度夹到 0.3–1', () => {
    expect(hudService.clampOpacity(0.1)).toBe(0.3)
    expect(hudService.clampOpacity(2)).toBe(1)
    expect(hudService.clampOpacity(0.7)).toBe(0.7)
  })
})

describe('形态判定 resolveDragStep（长条看边距 / 面板看出屏）', () => {
  const wa = PRIMARY.workArea

  it('长条态：gap > 48 才展开，正好 48 或更近都保持长条', () => {
    expect(hudService.resolveDragStep('ball', wa, { x: 800, y: 300, width: 132, height: 40 })).toBe(
      'expand'
    )
    // 左边距 30、右边距更远 → 不展开
    expect(hudService.resolveDragStep('ball', wa, { x: 30, y: 300, width: 132, height: 40 })).toBe(
      'none'
    )
    // 正好 48：不算「> 48」
    expect(hudService.resolveDragStep('ball', wa, { x: 48, y: 300, width: 132, height: 40 })).toBe(
      'none'
    )
  })

  it('面板态：出屏 0 → none', () => {
    expect(
      hudService.resolveDragStep('panel', wa, { x: 100, y: 300, width: 360, height: 480 })
    ).toBe('none')
  })

  it('面板态：右侧出屏恰为宽度 1/3 → none（边界取「超过才收」）', () => {
    // 360 × 1/3 = 120：1680 + 360 − 1920 = 120
    expect(
      hudService.resolveDragStep('panel', wa, { x: 1680, y: 300, width: 360, height: 480 })
    ).toBe('none')
  })

  it('面板态：右侧出屏 1/3 + 1 → collapse-right', () => {
    expect(
      hudService.resolveDragStep('panel', wa, { x: 1681, y: 300, width: 360, height: 480 })
    ).toBe('collapse-right')
  })

  it('面板态：左侧出屏 1/3 + 1 → collapse-left', () => {
    expect(
      hudService.resolveDragStep('panel', wa, { x: -121, y: 300, width: 360, height: 480 })
    ).toBe('collapse-left')
  })

  it('面板态：出屏再深也一样收（不会因为「离边更远」就放过）', () => {
    expect(
      hudService.resolveDragStep('panel', wa, { x: 1900, y: 300, width: 360, height: 480 })
    ).toBe('collapse-right')
    expect(
      hudService.resolveDragStep('panel', wa, { x: -340, y: 300, width: 360, height: 480 })
    ).toBe('collapse-left')
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

  const modeEvents = (): DomainEvent[] => events.filter(e => e.type === 'hud.mode.changed')

  it('默认形态是长条：132×40 贴右、y = 10%，不可拉伸，且把回落的显示器写回', () => {
    const { win } = attachDefault()
    expect(win.getBounds()).toEqual({ x: 1788, y: 104, width: 132, height: 40 })
    expect(win.resizable()).toBe(false)
    expect(win.minSize()).toEqual([0, 0])
    expect(settingRepo.get('hud.displayId')).toBe(1)
    expect(hudService.getState()).toEqual({ mode: 'ball', displayId: 1, visible: true })
  })

  it('库里的旧形态串（dock-bar / float-pod / 未知）一律按 ball 起', () => {
    for (const legacy of ['dock-bar', 'float-pod', 'nonsense']) {
      settingRepo.set('hud.mode', legacy as unknown as HudMode)
      const displays = makeDisplays([PRIMARY])
      const win = makeWindow(hudService.resolveInitialBounds(displays))
      hudService.attach(win, displays)
      expect(hudService.getState().mode).toBe('ball')
      expect(win.getBounds()).toEqual({ x: 1788, y: 104, width: 132, height: 40 })
      hudService.detach()
    }
  })

  it('setMode(panel)：只换 bounds 不重建窗口，可拉伸 + 上下限，并广播 hud.mode.changed', () => {
    const { win } = attachDefault()
    const callsBefore = win.boundsCalls.length

    hudService.setMode('panel')

    expect(win.boundsCalls.length).toBe(callsBefore + 1)
    // 贴右边缘展开：1788 + 132 − 360 = 1560（正好贴住右边缘，不再内缩 25px）
    expect(win.getBounds()).toEqual({ x: 1560, y: 104, width: 360, height: 480 })
    expect(win.resizable()).toBe(true)
    expect(win.minSize()).toEqual([280, 320])
    expect(win.maxSize()).toEqual([720, 900])
    expect(settingRepo.get('hud.mode')).toBe('panel')
    expect(modeEvents()).toEqual([{ type: 'hud.mode.changed', mode: 'panel' }])
  })

  it('面板尺寸：hud.size 生效；收球再展开回到用户拉过的尺寸', () => {
    settingRepo.set('hud.mode', 'panel')
    settingRepo.set('hud.size', { width: 500, height: 600 })
    const { win } = attachDefault()
    // y 仍是 10%（104），x 被 500 宽的面板顶回工作区内（1920 − 500）
    expect(win.getBounds()).toEqual({ x: 1420, y: 104, width: 500, height: 600 })

    hudService.setMode('ball')
    expect(win.getBounds()).toEqual({ x: 1420, y: 104, width: 132, height: 40 })
    // 长条态不覆盖面板尺寸：再展开还是 500×600
    hudService.setMode('panel')
    expect(win.getBounds().width).toBe(500)
    expect(win.getBounds().height).toBe(600)
    expect(settingRepo.get('hud.size')).toEqual({ width: 500, height: 600 })
  })

  it('长条拖动中实时变形：move 去抖 120ms 后 gap > 48 → 当场展开成面板', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    win.boundsCalls.length = 0

    win.dragTo(200, 300)
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS - 1)
    expect(hudService.getState().mode).toBe('ball')

    vi.advanceTimersByTime(1)
    expect(hudService.getState().mode).toBe('panel')
    expect(win.getBounds()).toEqual({ x: 200, y: 300, width: 360, height: 480 })
    expect(win.resizable()).toBe(true)
    expect(modeEvents()).toEqual([{ type: 'hud.mode.changed', mode: 'panel' }])
  })

  it('面板拖到右侧出屏 1/3 + 1：move 去抖后当场收长条并贴右边', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    hudService.setMode('panel')
    win.boundsCalls.length = 0

    win.dragTo(1681, 300)
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS)

    expect(hudService.getState().mode).toBe('ball')
    expect(win.getBounds()).toEqual({ x: 1788, y: 300, width: 132, height: 40 })
    expect(win.resizable()).toBe(false)
    expect(modeEvents().map(e => e.type === 'hud.mode.changed' && e.mode)).toEqual([
      'panel',
      'ball'
    ])
  })

  it('面板拖出右边缘 1/4（出屏 90 ≤ 1/3）松手：保持面板、位置不动（不推回屏内）', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    hudService.setMode('panel')
    win.boundsCalls.length = 0

    win.dragTo(1650, 300)
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS)
    expect(hudService.getState().mode).toBe('panel')
    expect(win.boundsCalls).toHaveLength(0)

    vi.advanceTimersByTime(hudService.SETTLE_MS)
    expect(win.getBounds()).toEqual({ x: 1650, y: 300, width: 360, height: 480 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1650, y: 300 })
  })

  it('面板 bounds 横向按原值（允许负 x）、纵向仍被夹', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    hudService.setMode('panel')
    win.boundsCalls.length = 0

    // 左下角：x 出屏 50（≤ 1/3，不收）、y 超出底部 40 → 只夹 y
    win.dragTo(-50, 600)
    win.fireMove()
    vi.advanceTimersByTime(hudService.SETTLE_MS)

    expect(win.getBounds()).toEqual({ x: -50, y: 560, width: 360, height: 480 })
    expect(settingRepo.get('hud.position')).toEqual({ x: -50, y: 560 })
  })

  it('只发 resize（不经 move 去抖）：收尾时 settle 自己判一次形态，照样收长条', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    hudService.setMode('panel')
    win.boundsCalls.length = 0

    // 位置已经在屏外 1/3 以上，但没有任何 move 事件 → judgeShape 不会跑。
    // 尺寸也要变，否则这次 resize 会被当成 setBounds 回声吞掉（不会排 settle）。
    win.dragTo(1700, 300)
    win.resizeTo(420, 480)
    win.fireResize()
    vi.advanceTimersByTime(hudService.SETTLE_MS)

    expect(hudService.getState().mode).toBe('ball')
    expect(win.getBounds()).toEqual({ x: 1788, y: 300, width: 132, height: 40 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1788, y: 300 })
    expect(settingRepo.get('hud.mode')).toBe('ball')
  })

  it('不来回切：长条拖到 gap 30 保持长条；面板贴左边缘（出屏 0）也保持面板', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    win.boundsCalls.length = 0

    win.dragTo(30, 300)
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS)
    expect(hudService.getState().mode).toBe('ball')
    expect(win.boundsCalls).toHaveLength(0)

    hudService.setMode('panel')
    const panelCalls = win.boundsCalls.length
    // y 错开 20px：与 setBounds 目标不同，才不会被当成回声吞掉（这里要测的是形态判定，不是回声）
    win.dragTo(30, 320)
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS)
    expect(hudService.getState().mode).toBe('panel')
    expect(win.boundsCalls.length).toBe(panelCalls)
  })

  it('分数缩放（150%）下回读差 1px 不算拖动：不得自我漂移（反复 setBounds）', () => {
    vi.useFakeTimers()
    const displays = makeDisplays([PRIMARY])
    const win = makeWindow(hudService.resolveInitialBounds(displays))
    // 本机就是 150%：setBounds(132×40) 回读会差 1px
    win.setDpiOffset(1, 1)
    hudService.attach(win, displays)
    const afterAttach = win.boundsCalls.length

    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS + hudService.SETTLE_MS + 500)

    expect(win.boundsCalls.length).toBe(afterAttach)
    expect(hudService.getState().mode).toBe('ball')
  })

  it('回声抑制：程序化 setBounds 引发的 move 被丢弃，不会触发第二次切换（防死循环）', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    hudService.setMode('panel') // 展开落点完全在屏内（出屏 0），本身不该被收回去
    const afterExpand = win.boundsCalls.length
    expect(hudService.offscreenOf(PRIMARY.workArea, win.getBounds())).toEqual({ left: 0, right: 0 })

    // 窗口回抛的 move（位置与目标一致）—— 丢
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS)
    expect(hudService.getState().mode).toBe('panel')
    expect(win.boundsCalls.length).toBe(afterExpand)

    // 再来一次也必须是幂等的
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS)
    expect(hudService.getState().mode).toBe('panel')
    expect(win.boundsCalls.length).toBe(afterExpand)
    expect(modeEvents()).toHaveLength(1)
  })

  it('拖动/拉伸收尾：300ms 后落 hud.position / hud.size，越界则 clamp 回工作区', () => {
    vi.useFakeTimers()
    const { win } = attachDefault()
    hudService.setMode('panel')
    win.boundsCalls.length = 0

    // 拖到中间（出屏 0，不会收长条），收尾后位置落库
    win.dragTo(1400, 300)
    win.fireMove()
    vi.advanceTimersByTime(hudService.SETTLE_MS)
    expect(settingRepo.get('hud.position')).toEqual({ x: 1400, y: 300 })

    win.resizeTo(520, 640)
    win.fireResize()
    vi.advanceTimersByTime(hudService.SETTLE_MS)
    expect(settingRepo.get('hud.size')).toEqual({ width: 520, height: 640 })
    // 拉伸后不能被旧尺寸弹回
    expect(win.getBounds()).toEqual({ x: 1400, y: 300, width: 520, height: 640 })

    // 越界：长条被拖出屏幕，收尾时 clamp 回来
    hudService.setMode('ball')
    win.dragTo(5000, 5000)
    win.fireMove()
    vi.advanceTimersByTime(hudService.MOVE_JUDGE_MS)
    vi.advanceTimersByTime(hudService.SETTLE_MS)
    expect(win.getBounds()).toEqual({ x: 1788, y: 1000, width: 132, height: 40 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1788, y: 1000 })
  })

  it('展开/收球往返不涨尺寸：OS 回读 +1px 不算用户拉伸（否则每往返一次胖 1px）', () => {
    vi.useFakeTimers()
    const displays = makeDisplays([PRIMARY])
    const win = makeWindow(hudService.resolveInitialBounds(displays))
    win.setDpiOffset(1, 1, 1, 1)
    hudService.attach(win, displays)
    win.boundsCalls.length = 0

    for (let i = 0; i < 3; i++) {
      hudService.setMode('panel')
      // 自己的 setBounds 也会引发 move + resize：两条都得当回声吞掉
      win.fireMove()
      win.fireResize()
      vi.advanceTimersByTime(hudService.SETTLE_MS)
      hudService.setMode('ball')
      win.fireMove()
      win.fireResize()
      vi.advanceTimersByTime(hudService.SETTLE_MS)
    }

    // 每次都按 360×480 请求，不跟着回读的 361×481 长
    for (const call of win.boundsCalls.filter(r => r.width > 132)) {
      expect([call.width, call.height]).toEqual([360, 480])
    }
    expect(settingRepo.get('hud.size')).toBeNull()
  })

  it('重启：位置与尺寸都保持（形态也保持）', () => {
    vi.useFakeTimers()
    const displays = makeDisplays([PRIMARY])
    const { win } = attachDefault(displays)
    hudService.setMode('panel')
    win.dragTo(700, 200)
    win.fireMove()
    vi.advanceTimersByTime(hudService.SETTLE_MS)
    win.resizeTo(600, 700)
    win.fireResize()
    vi.advanceTimersByTime(hudService.SETTLE_MS)
    expect(settingRepo.get('hud.position')).toEqual({ x: 700, y: 200 })

    hudService.detach()
    const restart = makeWindow(hudService.resolveInitialBounds(displays))
    hudService.attach(restart, displays)
    expect(hudService.getState().mode).toBe('panel')
    expect(restart.getBounds()).toEqual({ x: 700, y: 200, width: 600, height: 700 })
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

  it('setVisible 各广播一次 hud.visible.changed，载荷等于目标值', () => {
    const { win } = attachDefault()
    const visibleEvents = (): DomainEvent[] => events.filter(e => e.type === 'hud.visible.changed')

    hudService.setVisible(false)
    expect(visibleEvents()).toEqual([{ type: 'hud.visible.changed', visible: false }])
    expect(win.isVisible()).toBe(false)

    hudService.setVisible(true)
    expect(visibleEvents()).toEqual([
      { type: 'hud.visible.changed', visible: false },
      { type: 'hud.visible.changed', visible: true }
    ])
    expect(win.isVisible()).toBe(true)
  })

  it('拔屏：记忆的显示器不在了 → 回落主屏并 clamp，不留在屏幕外', () => {
    settingRepo.set('hud.displayId', 2)
    settingRepo.set('hud.mode', 'panel')
    settingRepo.set('hud.position', { x: 2500, y: 300 })
    const twoScreens = makeDisplays([PRIMARY, SECOND])
    const { win } = attachDefault(twoScreens)
    expect(win.getBounds()).toEqual({ x: 2500, y: 300, width: 360, height: 480 })

    // 副屏拔掉：只剩主屏，显示器配置变化后重新 clamp
    twoScreens.areas = [PRIMARY]
    hudService.syncDisplays()

    const bounds = win.getBounds()
    expect(bounds.width).toBe(360)
    expect(bounds.x).toBeLessThanOrEqual(PRIMARY.workArea.width - 360)
    expect(settingRepo.get('hud.displayId')).toBe(1)
    expect(hudService.getState().displayId).toBe(1)
  })

  it('工作区变小（分辨率/缩放变化）：尺寸与坐标一起收回来', () => {
    settingRepo.set('hud.mode', 'panel')
    settingRepo.set('hud.size', { width: 700, height: 880 })
    const displays = makeDisplays([PRIMARY])
    const { win } = attachDefault(displays)

    displays.areas = [{ displayId: 1, workArea: { x: 0, y: 0, width: 1280, height: 720 } }]
    hudService.syncDisplays()

    const bounds = win.getBounds()
    expect(bounds.width).toBe(700)
    expect(bounds.height).toBe(720)
    expect(bounds.x).toBeLessThanOrEqual(1280 - 700)
    expect(settingRepo.get('hud.size')).toEqual({ width: 700, height: 720 })
  })

  it('moveTo：clamp 进工作区再落库（程序化移动不触发变形判定）', () => {
    const { win } = attachDefault()
    hudService.moveTo(5000, 5000)
    expect(win.getBounds()).toEqual({ x: 1788, y: 1000, width: 132, height: 40 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1788, y: 1000 })
    expect(hudService.getState().mode).toBe('ball')
  })

  it('dragBy(-20, 30, false)：窗口跟着平移，但位置不落库', () => {
    const { win } = attachDefault()
    expect(settingRepo.get('hud.position')).toEqual({ x: null, y: null })

    hudService.dragBy(-20, 30, false)
    expect(win.getBounds()).toEqual({ x: 1768, y: 134, width: 132, height: 40 })
    // 拖动中不写库：拖到一半退出会停在半路
    expect(settingRepo.get('hud.position')).toEqual({ x: null, y: null })
    expect(hudService.getState().mode).toBe('ball')
  })

  it('dragBy 拖出工作区：整条被 clamp 回屏内（不锁边，只是不出屏）', () => {
    const { win } = attachDefault()
    hudService.dragBy(500, 2000, false)
    expect(win.getBounds()).toEqual({ x: 1788, y: 1000, width: 132, height: 40 })

    hudService.dragBy(-3000, -3000, false)
    expect(win.getBounds()).toEqual({ x: 0, y: 0, width: 132, height: 40 })
  })

  it('dragBy(0, 0, true)：贴右边松手 → 位置落库，形态仍是长条', () => {
    const { win } = attachDefault()
    hudService.dragBy(-10, 40, false)
    hudService.dragBy(0, 0, true)

    expect(win.getBounds()).toEqual({ x: 1778, y: 144, width: 132, height: 40 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1778, y: 144 })
    expect(hudService.getState().mode).toBe('ball')
    expect(modeEvents()).toEqual([])
  })

  it('长条拖离边缘 > 48 后松手：主进程判形态 → 展开成面板（走 enterMode）', () => {
    const { win } = attachDefault()
    hudService.dragBy(-988, 0, false)
    // 拖动中不判形态：已经到屏幕中间了，还是长条
    expect(hudService.getState().mode).toBe('ball')
    expect(win.getBounds()).toEqual({ x: 800, y: 104, width: 132, height: 40 })

    hudService.dragBy(0, 0, true)
    expect(hudService.getState().mode).toBe('panel')
    expect(win.getBounds()).toEqual({ x: 800, y: 104, width: 360, height: 480 })
    expect(win.resizable()).toBe(true)
    expect(modeEvents()).toEqual([{ type: 'hud.mode.changed', mode: 'panel' }])
    expect(settingRepo.get('hud.mode')).toBe('panel')
    expect(settingRepo.get('hud.position')).toEqual({ x: 800, y: 104 })
  })

  it('面板态调 dragBy：直接返回，bounds 与落库位置都不动', () => {
    const { win } = attachDefault()
    hudService.setMode('panel')
    const before = win.getBounds()
    const stored = settingRepo.get('hud.position')
    win.boundsCalls.length = 0

    hudService.dragBy(60, 60, false)
    hudService.dragBy(60, 60, true)

    expect(win.boundsCalls).toHaveLength(0)
    expect(win.getBounds()).toEqual(before)
    expect(settingRepo.get('hud.position')).toEqual(stored)
    expect(hudService.getState().mode).toBe('panel')
  })
})
