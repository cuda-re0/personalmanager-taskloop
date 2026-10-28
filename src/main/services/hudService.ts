import type { HudMode } from '@shared/types/ipc'
import { broadcast } from '../bus'
import * as settingRepo from '../db/repositories/settingRepo'

/**
 * HUD 状态机（W9 · 04 §5）。
 *
 * 职责边界：
 * - **唯一**持有 `{ mode, expanded, visible, displayId, bounds }`，所有变更都从这里走；
 *   渲染层只调通道，不自己算坐标（04 §5.2「用主进程控制窗口高度而非 CSS」）。
 * - 持久化只用已登记的四个 key：`hud.mode` / `hud.displayId` / `hud.position`（float-pod 坐标）/
 *   `hud.expanded`（两模式各一份）。**不新增 key**。
 * - 窗口与显示器走注入的端口（`HudWindowPort` / `HudDisplaysPort`）：本文件不 import electron 值，
 *   因此在 `ELECTRON_RUN_AS_NODE` 的测试宿主里可以直接跑，用假端口断言 setBounds 序列。
 *
 * 坐标口径：统一用 `display.workArea`（`bounds` 含任务栏区域，会压到任务栏下面，04 §5.2 / §8）。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface HudDisplayArea {
  displayId: number
  /** 该显示器的工作区（已扣掉任务栏） */
  workArea: Rect
}

/** 显示器查询端口：`workAreaOf` 找不到记忆的屏（拔屏）时必须回落主屏 */
export interface HudDisplaysPort {
  workAreaOf(displayId: number | null): HudDisplayArea
  nearestWorkArea(rect: Rect): HudDisplayArea
}

/** 窗口端口：只暴露 HUD 需要的几个动作，便于测试注入假实现 */
export interface HudWindowPort {
  getBounds(): Rect
  setBounds(rect: Rect): void
  setMovable(movable: boolean): void
  hide(): void
  showInactive(): void
  isVisible(): boolean
  onMove(listener: () => void): void
  isDestroyed(): boolean
}

export interface HudState {
  mode: HudMode
  expanded: boolean
  /** 应显示（不是 `win.isVisible()` 的瞬时值，见 `getState` 注释） */
  visible: boolean
  displayId: number
  bounds: Rect
}

/* ------------------------------------------------------------------ *
 * 尺寸常量（04 §5.2 / §5.3，照抄，不自己发明）
 * ------------------------------------------------------------------ */

export const DOCK_HEIGHT = 32
export const DOCK_EXPANDED_HEIGHT = 260
export const DOCK_EDGE_INSET = 8
/** 展开高度上限还要给底部留 8px：`min(260, workArea.height - 8)` */
export const DOCK_BOTTOM_GAP = 8

export const POD_SIZE = 56
export const POD_INSET = 24
export const POD_PANEL_WIDTH = 360
export const POD_PANEL_MAX_HEIGHT = 480

/** 松手后距屏边 < 24px 吸附 */
export const SNAP_THRESHOLD = 24
/** 主进程 `move` 去抖：300ms 内的连续 move 视为同一次拖动（drag 区域收不到 mouseup，见开工词「坑 2」） */
export const DRAG_SETTLE_MS = 300

/* ------------------------------------------------------------------ *
 * 纯几何（导出只为可测：四形态 × 屏幕边缘 / 多屏 / 记忆坐标缺失）
 * ------------------------------------------------------------------ */

/** 整体 clamp 进 workArea；宽高超出时贴左上（不产出负坐标） */
export function clampInto(workArea: Rect, rect: Rect): Rect {
  const maxX = workArea.x + workArea.width - rect.width
  const maxY = workArea.y + workArea.height - rect.height
  const x = Math.min(Math.max(rect.x, workArea.x), Math.max(workArea.x, maxX))
  const y = Math.min(Math.max(rect.y, workArea.y), Math.max(workArea.y, maxY))
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

/** dock-bar：贴顶、左右各留 8px，收起 32 / 展开 min(260, workArea.height - 8) */
export function dockBarBounds(workArea: Rect, expanded: boolean): Rect {
  const height = expanded
    ? Math.min(DOCK_EXPANDED_HEIGHT, workArea.height - DOCK_BOTTOM_GAP)
    : DOCK_HEIGHT
  return {
    x: workArea.x + DOCK_EDGE_INSET,
    y: workArea.y,
    width: Math.max(1, workArea.width - DOCK_EDGE_INSET * 2),
    height: Math.max(1, Math.round(height))
  }
}

/** float-pod 无记忆时的默认落点：右上角内缩 24px */
export function defaultPodPoint(workArea: Rect): Point {
  return { x: workArea.x + workArea.width - POD_SIZE - POD_INSET, y: workArea.y + POD_INSET }
}

/**
 * float-pod 展开面板（04 §5.3「从圆的位置向屏幕内侧弹」）：
 * - 水平：圆在屏幕右半 → 以圆右边缘为基准向左长；圆在左半 → 向右长
 * - 垂直：`podY + 480` 超出底边 → 向上收到底边 - 480
 * - 最后整体 clamp 进 workArea（x/y 双向）
 */
export function podPanelBounds(workArea: Rect, pod: Point): Rect {
  const width = POD_PANEL_WIDTH
  const height = Math.min(POD_PANEL_MAX_HEIGHT, workArea.height)

  const podCenterX = pod.x + POD_SIZE / 2
  const rightHalf = podCenterX >= workArea.x + workArea.width / 2
  const x = rightHalf ? pod.x + POD_SIZE - width : pod.x

  const bottom = workArea.y + workArea.height
  const y = pod.y + POD_PANEL_MAX_HEIGHT > bottom ? bottom - POD_PANEL_MAX_HEIGHT : pod.y

  return clampInto(workArea, { x, y, width, height })
}

/** float-pod 四形态：收起是 56×56 圆，展开是 360×min(480, h) 面板 */
export function podBounds(workArea: Rect, pod: Point, expanded: boolean): Rect {
  if (expanded) return podPanelBounds(workArea, pod)
  return clampInto(workArea, { x: pod.x, y: pod.y, width: POD_SIZE, height: POD_SIZE })
}

/** 松手吸附：距左/右边缘 < 24 → 贴边；距顶/底 < 24 → 贴角；吸附后再 clamp 一次 */
export function snapPod(workArea: Rect, point: Point): Point {
  const base = clampInto(workArea, { ...point, width: POD_SIZE, height: POD_SIZE })
  let { x, y } = base
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height

  if (x - workArea.x < SNAP_THRESHOLD) x = workArea.x
  else if (right - (x + POD_SIZE) < SNAP_THRESHOLD) x = right - POD_SIZE

  if (y - workArea.y < SNAP_THRESHOLD) y = workArea.y
  else if (bottom - (y + POD_SIZE) < SNAP_THRESHOLD) y = bottom - POD_SIZE

  const snapped = clampInto(workArea, { x, y, width: POD_SIZE, height: POD_SIZE })
  return { x: snapped.x, y: snapped.y }
}

function clampPoint(workArea: Rect, point: Point): Point {
  const rect = clampInto(workArea, { ...point, width: POD_SIZE, height: POD_SIZE })
  return { x: rect.x, y: rect.y }
}

/* ------------------------------------------------------------------ *
 * 运行时
 * ------------------------------------------------------------------ */

interface Layout {
  mode: HudMode
  expanded: boolean
  displayId: number
  workArea: Rect
  pod: Point
}

let port: HudWindowPort | null = null
let displays: HudDisplaysPort | null = null
let state: HudState | null = null
/** float-pod 圆心的持久坐标（展开时也保持不变：面板位置由它推导，不是反向写回） */
let podPoint: Point | null = null
let moveTimer: ReturnType<typeof setTimeout> | null = null

function requirePort(): HudWindowPort {
  if (!port) throw new Error('HUD 窗口尚未创建（hudService.attach 未被调用）')
  return port
}

function requireDisplays(): HudDisplaysPort {
  if (!displays) throw new Error('HUD 显示器端口尚未注入（hudService.attach 未被调用）')
  return displays
}

function requireState(): HudState {
  if (!state) throw new Error('HUD 状态尚未初始化（hudService.attach 未被调用）')
  return state
}

function boundsFor(layout: Layout): Rect {
  return layout.mode === 'dock-bar'
    ? dockBarBounds(layout.workArea, layout.expanded)
    : podBounds(layout.workArea, layout.pod, layout.expanded)
}

/** 从 settings 还原一次完整布局（启动时用，`hud.displayId` 找不到屏即回落主屏） */
function resolveLayout(displayPort: HudDisplaysPort): Layout {
  const mode = settingRepo.get('hud.mode')
  const expandedMap = settingRepo.get('hud.expanded')
  const position = settingRepo.get('hud.position')
  const area = displayPort.workAreaOf(settingRepo.get('hud.displayId'))

  const pod =
    position.x === null || position.y === null
      ? defaultPodPoint(area.workArea)
      : clampPoint(area.workArea, { x: position.x, y: position.y })

  return {
    mode,
    expanded: expandedMap[mode] === true,
    displayId: area.displayId,
    workArea: area.workArea,
    pod
  }
}

/** 建窗之前先算初始 bounds（windowManager 用它创建 BrowserWindow，避免先建再挪的闪烁） */
export function resolveInitialBounds(displayPort: HudDisplaysPort): Rect {
  return boundsFor(resolveLayout(displayPort))
}

function computeBounds(): Rect {
  const current = requireState()
  const area = requireDisplays().workAreaOf(current.displayId)
  return boundsFor({
    mode: current.mode,
    expanded: current.expanded,
    displayId: area.displayId,
    workArea: area.workArea,
    pod: podPoint ?? defaultPodPoint(area.workArea)
  })
}

function applyBounds(): void {
  const target = requirePort()
  const current = requireState()
  const next = computeBounds()
  current.bounds = next
  target.setBounds(next)
}

function persistDisplayId(displayId: number): void {
  if (settingRepo.get('hud.displayId') !== displayId) settingRepo.set('hud.displayId', displayId)
}

function persistPosition(point: Point): void {
  const stored = settingRepo.get('hud.position')
  if (stored.x !== point.x || stored.y !== point.y) {
    settingRepo.set('hud.position', { x: point.x, y: point.y })
  }
}

/**
 * 挂上窗口与显示器端口。由 `windowManager.createHudWindow()` 在窗口建好后调用。
 * 重复调用视为重连：先清空旧计时器与状态，不叠加监听。
 */
export function attach(windowPort: HudWindowPort, displaysPort: HudDisplaysPort): void {
  detach()
  port = windowPort
  displays = displaysPort

  const layout = resolveLayout(displaysPort)
  state = {
    mode: layout.mode,
    expanded: layout.expanded,
    visible: true,
    displayId: layout.displayId,
    bounds: boundsFor(layout)
  }
  podPoint = layout.pod

  windowPort.setMovable(layout.mode === 'float-pod')
  applyBounds()
  windowPort.onMove(handleWindowMove)

  // 记忆的显示器不在了（拔屏）：把回落结果写回，下次重启不再找旧屏
  persistDisplayId(layout.displayId)
}

/** 卸载端口（窗口销毁时调用；测试里也用它隔离用例） */
export function detach(): void {
  if (moveTimer) {
    clearTimeout(moveTimer)
    moveTimer = null
  }
  port = null
  displays = null
  state = null
  podPoint = null
}

function handleWindowMove(): void {
  if (moveTimer) clearTimeout(moveTimer)
  moveTimer = setTimeout(settleMove, DRAG_SETTLE_MS)
}

/**
 * 拖动收尾（开工词「坑 2」：drag 区域收不到 mouseup，所以由主进程 move 去抖来判定"松手"）。
 * dock-bar 不可拖；float-pod 展开态面板不跟随拖动。
 */
function settleMove(): void {
  moveTimer = null
  const current = requireState()
  const target = requirePort()
  if (current.mode !== 'float-pod' || current.expanded) return

  const rect = target.getBounds()
  // 程序化 setBounds 的回声：位置与状态一致说明不是用户拖动，直接忽略（否则吸附会被反复触发）
  if (rect.x === current.bounds.x && rect.y === current.bounds.y) return

  const area = requireDisplays().nearestWorkArea(rect)
  const snapped = snapPod(area.workArea, { x: rect.x, y: rect.y })

  podPoint = snapped
  current.displayId = area.displayId
  persistPosition(snapped)
  persistDisplayId(area.displayId)
  applyBounds()
}

/** 切换形态：换 bounds + 广播 `hud.mode.changed`，**不重建窗口**（04 §5.4） */
export function setMode(mode: HudMode): void {
  const current = requireState()
  if (current.mode === mode) return

  // 展开态各模式各记一份，切过去恢复该模式自己的那份
  const expandedMap = settingRepo.get('hud.expanded')
  current.mode = mode
  current.expanded = expandedMap[mode] === true

  settingRepo.set('hud.mode', mode)
  requirePort().setMovable(mode === 'float-pod')
  applyBounds()
  broadcast({ type: 'hud.mode.changed', mode })
}

/** 展开/收起：两模式通用，高度由主进程 setBounds，**不走 CSS** */
export function setExpanded(expanded: boolean): void {
  const current = requireState()
  if (current.expanded === expanded) return

  current.expanded = expanded
  const expandedMap = settingRepo.get('hud.expanded')
  if (expandedMap[current.mode] !== expanded) {
    settingRepo.set('hud.expanded', { ...expandedMap, [current.mode]: expanded })
  }
  applyBounds()
}

/** 程序化移动（float-pod 的拖动本身不依赖本通道，见 `settleMove`）：clamp + 落库 */
export function moveTo(x: number, y: number): void {
  const current = requireState()
  const area = requireDisplays().nearestWorkArea({ x, y, width: POD_SIZE, height: POD_SIZE })
  const point = clampPoint(area.workArea, { x, y })

  podPoint = point
  current.displayId = area.displayId
  persistPosition(point)
  persistDisplayId(area.displayId)
  applyBounds()
}

export function setVisible(visible: boolean): void {
  const current = requireState()
  const target = requirePort()
  current.visible = visible
  if (visible) target.showInactive()
  else target.hide()
}

/**
 * `visible` 取"应显示"状态而不是 `win.isVisible()` 的瞬时值：
 * 主窗渲染层可能在 HUD 的 `ready-to-show` 之前就调 `hud.getState()`，那时 `isVisible()` 还是 false，
 * 顶栏开关会显示关闭而 HUD 随后自己出现——开关初态必须与窗口的真实归宿一致。
 * 这条口径已在交付报告里报给架构方（02 §3.7b 原写"取 win.isVisible()"）。
 */
export function getState(): {
  mode: HudMode
  expanded: boolean
  displayId: number
  visible: boolean
} {
  const current = requireState()
  return {
    mode: current.mode,
    expanded: current.expanded,
    displayId: current.displayId,
    visible: current.visible && !requirePort().isDestroyed()
  }
}

/**
 * 显示器配置变化（`display-removed` / `display-metrics-changed`）后重算：
 * 记忆的屏不在了回落主屏，工作区变小则把圆 clamp 回来，最后重新 setBounds。
 */
export function syncDisplays(): void {
  const current = requireState()
  const area = requireDisplays().workAreaOf(current.displayId)

  current.displayId = area.displayId
  podPoint = clampPoint(area.workArea, podPoint ?? defaultPodPoint(area.workArea))

  persistDisplayId(area.displayId)
  persistPosition(podPoint)
  applyBounds()
}
