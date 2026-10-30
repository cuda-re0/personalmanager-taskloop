import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CH } from '@shared/channels'
import type { IpcResult } from '@shared/types/ipc'
import type { DomainEvent } from '@shared/types/events'
import { setTransport } from '../../src/main/bus'
import * as settingRepo from '../../src/main/db/repositories/settingRepo'
import * as hudService from '../../src/main/services/hudService'
import type { HudDisplaysPort, HudWindowPort, Rect } from '../../src/main/services/hudService'
import { createHandlers, type IpcLike } from '../../src/main/ipc/registry'
import { closeTestDb, openMemoryDb } from '../db/helpers'

/**
 * W9 · 四条 hud 通道（04 §3.7b v0.30，`hud.setExpanded` 已删除）。
 *
 * 覆盖"接线"本身：守卫形状、handler 转发到 hudService、广播、`getState().visible` 一致性。
 * 几何细节在 tests/main/hudService.test.ts；`app.setSetting` 里三个 hud 项的形状/夹限也在这里锁。
 */

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  BrowserWindow: { getAllWindows: () => [] }
}))

const AREA = { displayId: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }

function makeDisplays(): HudDisplaysPort {
  return { workAreaOf: () => AREA, nearestWorkArea: () => AREA }
}

function makeWindow(initial: Rect): HudWindowPort & { hidden: boolean } {
  let bounds = { ...initial }
  const self = {
    hidden: false,
    getBounds: () => ({ ...bounds }),
    setBounds: (rect: Rect) => {
      bounds = { ...rect }
    },
    setMovable: () => undefined,
    setResizable: () => undefined,
    setMinSize: () => undefined,
    setMaxSize: () => undefined,
    hide: () => {
      self.hidden = true
    },
    showInactive: () => {
      self.hidden = false
    },
    isVisible: () => !self.hidden,
    onMove: () => undefined,
    onResize: () => undefined,
    isDestroyed: () => false
  }
  return self
}

describe('W9 四条 hud 通道（假 ipc + 假窗口 + 内存库）', () => {
  let wired: Map<string, (input: unknown) => unknown>
  let events: DomainEvent[]
  let win: ReturnType<typeof makeWindow>

  const call = (channel: string, input?: unknown): IpcResult<unknown> => {
    const fn = wired.get(channel)
    if (!fn) throw new Error(`通道未注册: ${channel}`)
    return fn(input) as IpcResult<unknown>
  }

  const callOk = <T>(channel: string, input?: unknown): T => {
    const result = call(channel, input)
    if (!result.ok) {
      throw new Error(`预期 ${channel} ok:true，实际 ${result.error.code}: ${result.error.message}`)
    }
    return result.data as T
  }

  beforeEach(() => {
    openMemoryDb()
    events = []
    setTransport(e => events.push(e))
    wired = createHandlers({ handle() {} } as IpcLike)
    const displays = makeDisplays()
    win = makeWindow(hudService.resolveInitialBounds(displays))
    hudService.attach(win, displays)
  })

  afterEach(() => {
    hudService.detach()
    closeTestDb()
  })

  it('六条都注册了（setExpanded 不再存在），且不再是 NOT_WIRED', () => {
    for (const ch of [
      CH.hud.setMode,
      CH.hud.moveTo,
      CH.hud.dragBegin,
      CH.hud.dragTo,
      CH.hud.setVisible,
      CH.hud.getState
    ]) {
      expect(wired.has(ch)).toBe(true)
    }
    expect(wired.size).toBe(43)
  })

  it('hud.getState 返回 { mode, displayId, visible }，不含 expanded', () => {
    const state = callOk<Record<string, unknown>>(CH.hud.getState)
    expect(Object.keys(state).sort()).toEqual(['displayId', 'mode', 'visible'])
    expect(state).toEqual({ mode: 'ball', displayId: 1, visible: true })
  })

  it('hud.setVisible → 窗口 hide/showInactive，getState().visible 与之一致', () => {
    callOk(CH.hud.setVisible, { visible: false })
    expect(win.hidden).toBe(true)
    expect(callOk<{ visible: boolean }>(CH.hud.getState).visible).toBe(false)

    callOk(CH.hud.setVisible, { visible: true })
    expect(win.hidden).toBe(false)
    expect(callOk<{ visible: boolean }>(CH.hud.getState).visible).toBe(true)
  })

  it('hud.setMode → 广播 hud.mode.changed，窗口本身不重建（bounds 直接变）', () => {
    callOk(CH.hud.setMode, { mode: 'panel' })
    expect(win.getBounds()).toEqual({
      width: 360,
      height: 480,
      x: 1560,
      y: 104
    })
    expect(events.filter(e => e.type === 'hud.mode.changed')).toEqual([
      { type: 'hud.mode.changed', mode: 'panel' }
    ])
    expect(callOk<{ mode: string }>(CH.hud.getState).mode).toBe('panel')
  })

  it('hud.moveTo → clamp 进 workArea 并落库', () => {
    callOk(CH.hud.moveTo, { x: 9999, y: 9999 })
    expect(win.getBounds()).toEqual({ x: 1788, y: 1000, width: 132, height: 40 })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1788, y: 1000 })
  })

  it('hud.dragBegin → 返回长条左上角；hud.dragTo 走绝对坐标，end:true 才落库（v0.32）', () => {
    expect(callOk<{ x: number; y: number }>(CH.hud.dragBegin)).toEqual({ x: 1788, y: 104 })

    callOk(CH.hud.dragTo, { x: 1743, y: 124, end: false })
    expect(win.getBounds()).toEqual({ x: 1743, y: 124, width: 132, height: 40 })
    expect(settingRepo.get('hud.position')).toEqual({ x: null, y: null })

    callOk(CH.hud.dragTo, { x: 1743, y: 124, end: true })
    expect(settingRepo.get('hud.position')).toEqual({ x: 1743, y: 124 })
    expect(callOk<{ mode: string }>(CH.hud.getState).mode).toBe('ball')
  })

  it('非法入参统一 INVALID_INPUT（04 §1.1「请求参数格式不正确」），且不改窗口', () => {
    const before = win.getBounds()
    for (const [channel, input] of [
      [CH.hud.setMode, { mode: 'flying' }],
      [CH.hud.moveTo, { x: 1 }],
      // dragTo 少 end 字段 → 形状不完整
      [CH.hud.dragTo, { x: 1, y: 2 }],
      [CH.hud.setVisible, {}]
    ] as const) {
      const result = call(channel, input)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_INPUT')
        expect(result.error.message).toBe('请求参数格式不正确')
      }
    }
    expect(win.getBounds()).toEqual(before)
  })

  it('app.setSetting 收口三个 hud 项：opacity 夹到 0.3–1、size 夹到值域、背景色形态', () => {
    callOk(CH.app.setSetting, { key: 'hud.opacity', value: 0.1 })
    expect(settingRepo.get('hud.opacity')).toBe(0.3)
    callOk(CH.app.setSetting, { key: 'hud.opacity', value: 5 })
    expect(settingRepo.get('hud.opacity')).toBe(1)

    callOk(CH.app.setSetting, { key: 'hud.size', value: { width: 100, height: 5000 } })
    expect(settingRepo.get('hud.size')).toEqual({ width: 280, height: 900 })
    callOk(CH.app.setSetting, { key: 'hud.size', value: null })
    expect(settingRepo.get('hud.size')).toBeNull()

    callOk(CH.app.setSetting, { key: 'hud.background', value: '#123456' })
    expect(settingRepo.get('hud.background')).toBe('#123456')

    for (const [key, value] of [
      ['hud.background', 'red'],
      ['hud.opacity', 'opaque'],
      ['hud.size', { width: '360' }]
    ] as const) {
      const result = call(CH.app.setSetting, { key, value })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('INVALID_INPUT')
    }
    // 被拒的写入不落库
    expect(settingRepo.get('hud.background')).toBe('#123456')
  })
})
