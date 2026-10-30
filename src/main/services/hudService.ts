import type { HudMode, HudSize } from '@shared/types/ipc'
import { broadcast } from '../bus'
import * as settingRepo from '../db/repositories/settingRepo'

/**
 * HUD 状态机（W9 · 04 §5 v0.31：长条 + 可拉伸面板）。
 *
 * 职责边界：
 * - **唯一**持有 `{ mode, visible, displayId, bounds }`，所有变更都从这里走；
 *   渲染层只调通道，不自己算坐标（04 §5「尺寸与坐标全部由主进程决定」）。
 * - 持久化只用已登记的 key：`hud.mode` / `hud.displayId` / `hud.position` / `hud.size`。
 *   `hud.expanded` 在 v0.30 删除（展开态概念作废，形态只有 ball / panel）。
 * - 窗口与显示器走注入的端口（`HudWindowPort` / `HudDisplaysPort`）：本文件不 import electron 值，
 *   因此在 `ELECTRON_RUN_AS_NODE` 的测试宿主里可以直接跑，用假端口断言 setBounds 序列。
 *
 * 坐标口径：统一用 `display.workArea`（`bounds` 含任务栏区域，会压到任务栏下面，04 §8）。
 *
 * 实时变形（04 §5.2，v0.31 裁决）：
 * - 长条态：距左/右边缘 > `EDGE_EXPAND`(48) → 当场展开成面板（落点由 `peekPanelBounds` 定）；
 * - 面板态：左/右**出屏**超过自身宽度 `PANEL_COLLAPSE_RATIO`(1/3) → 当场收成长条并贴该边；
 *   出屏 ≤ 1/3 时保持原样（面板允许半挂在屏幕外，不推回屏内）；
 * - 判定在 `move` 里去抖 `MOVE_JUDGE_MS`(120ms)，并在 `settle()` 里补判一次（快拖快放不到 120ms）；
 *   程序化 `setBounds` 的回声按目标 x/y 丢弃，否则"展开 → 面板贴边 → 收球 → 长条被拖开 → 展开"
 *   会无限自我切换。
 *
 * 长条拖动（v0.32，04 §5.2.2）：长条整条 no-drag，手势由渲染层判（点按 / 长按 / 手抖），
 * 拖动只发相对位移到 `dragBy()`；**拖动中不判形态**，`end:true` 时才落库并判一次。
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
  /** 面板可拉伸、球固定（04 §5.1 `resizable: mode === 'panel'`） */
  setResizable(resizable: boolean): void
  setMinSize(width: number, height: number): void
  setMaxSize(width: number, height: number): void
  hide(): void
  showInactive(): void
  isVisible(): boolean
  onMove(listener: () => void): void
  /** 拉伸收尾（落 `hud.size`）也走去抖，入口在这里 */
  onResize(listener: () => void): void
  isDestroyed(): boolean
}

export interface HudState {
  mode: HudMode
  /** 应显示（不是 `win.isVisible()` 的瞬时值，见 `getState` 注释） */
  visible: boolean
  displayId: number
  bounds: Rect
}

/* ------------------------------------------------------------------ *
 * 尺寸常量（04 §5.2 v0.31，照抄，不自己发明）
 * ------------------------------------------------------------------ */

/**
 * 长条尺寸。**形态值仍为 `ball`**，v0.31 起视觉是长条（改值域要动旧库归一与契约，不值当）。
 */
export const BALL_W = 132
export const BALL_H = 40
export const PANEL_W = 360
export const PANEL_H = 480
export const PANEL_MIN_W = 280
export const PANEL_MIN_H = 320
export const PANEL_MAX_W = 720
export const PANEL_MAX_H = 900
/** 首次启动：长条顶距工作区顶 = 高度 × 0.1 */
export const TOP_RATIO = 0.1

/** 长条态距边 > 48 展开（面板态不看这个，收起看「出屏 > 宽 1/3」） */
export const EDGE_EXPAND = 48
/**
 * 面板态收起门槛：左/右出屏超过自身宽度的 1/3 才收成长条。
 * 边界取「超过才收」——正好 1/3 时保持不动。
 */
export const PANEL_COLLAPSE_RATIO = 1 / 3

/** `move` 去抖：120ms 判一次形态 */
export const MOVE_JUDGE_MS = 120
/** 拖动/拉伸收尾落库去抖（位置 / 尺寸 / 形态） */
export const SETTLE_MS = 300
/**
 * 回声容忍度（DIP）。
 *
 * 契约原文是"比对目标与当前 x/y"，但在 Windows 分数缩放（本机 150%）下 `setBounds(360,480)`
 * 回读会差 1–2px（DIP↔物理像素取整）。用精确等值比较，自己的回声会被当成用户拖动，
 * 于是"收尾 → setBounds → move → 收尾"无限循环，实测窗口每 300ms 向左上漂 1px、宽度从 56 长到 57。
 * 所以这里按 ±2px 判等，同时 `settle()` 里小于该阈值的偏差不再回写（避免亚像素修正自我叠加）。
 */
export const ECHO_TOLERANCE = 2

export const DEFAULT_PANEL_SIZE: HudSize = { width: PANEL_W, height: PANEL_H }

/** 形态判定结果（纯函数产出，运行层执行） */
export type DragStep = 'expand' | 'collapse-left' | 'collapse-right' | 'none'

/* ------------------------------------------------------------------ *
 * 纯几何（导出只为可测）
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

/** 面板尺寸夹到 280×320 – 720×900（整数） */
export function clampSize(size: HudSize): HudSize {
  const width = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, Math.round(size.width)))
  const height = Math.min(PANEL_MAX_H, Math.max(PANEL_MIN_H, Math.round(size.height)))
  return { width, height }
}

/** 透明度夹到 0.3–1（保留两位，避免 0.30000000000000004 进库里） */
export function clampOpacity(value: number): number {
  const clamped = Math.min(1, Math.max(0.3, value))
  return Math.round(clamped * 100) / 100
}

/**
 * 面板尺寸适配工作区：先夹到契约值域，再保证不超过工作区
 * （工作区比最小尺寸还小时，只能取工作区尺寸——总比被窗口裁切好）。
 */
export function fitSize(workArea: Rect, size: HudSize): HudSize {
  const clamped = clampSize(size)
  return {
    width: Math.max(1, Math.min(clamped.width, workArea.width)),
    height: Math.max(1, Math.min(clamped.height, workArea.height))
  }
}

/** 长条可落点：任意位置，clamp 进工作区（不锁边、不吸附） */
export function clampBallPoint(workArea: Rect, point: Point): Point {
  const rect = clampInto(workArea, { ...point, width: BALL_W, height: BALL_H })
  return { x: rect.x, y: rect.y }
}

/** 首次启动的长条位：贴右边缘、距顶 = 工作区高度 × 0.1（TOP_RATIO） */
export function initialBallPoint(workArea: Rect): Point {
  return clampBallPoint(workArea, {
    x: workArea.x + workArea.width - BALL_W,
    y: workArea.y + Math.round(workArea.height * TOP_RATIO)
  })
}

/** 长条 bounds（132×40，clamp 进工作区） */
export function ballBounds(workArea: Rect, point: Point): Rect {
  const { x, y } = clampBallPoint(workArea, point)
  return { x, y, width: BALL_W, height: BALL_H }
}

/**
 * 长条 → 面板的落点（点长条展开 / 拖动中展开都用它）：
 * - 水平：长条中心在右半屏 → 以长条右边缘为基准向左长；在左半屏 → 向右长；
 * - 垂直：长条顶对齐面板顶；
 * - 最后整体 clamp 进工作区：展开后面板必然完全在屏内（出屏 = 0），不会触发「出屏 >1/3 收起」。
 */
export function peekPanelBounds(workArea: Rect, ball: Point, size: HudSize): Rect {
  const { width, height } = fitSize(workArea, size)
  const rightHalf = ball.x + BALL_W / 2 >= workArea.x + workArea.width / 2
  const x = rightHalf ? ball.x + BALL_W - width : ball.x

  return clampInto(workArea, { x, y: ball.y, width, height })
}

/** 面板 → 长条：贴指定边，纵向沿用面板顶（再 clamp 回来） */
export function ballFromPanel(workArea: Rect, rect: Rect, side: 'left' | 'right'): Point {
  const x = side === 'left' ? workArea.x : workArea.x + workArea.width - BALL_W
  return clampBallPoint(workArea, { x, y: rect.y })
}

/** 距左/右边缘的较小间距（负值 = 已出界） */
export function edgeGap(workArea: Rect, rect: Rect): number {
  const left = rect.x - workArea.x
  const right = workArea.x + workArea.width - (rect.x + rect.width)
  return Math.min(left, right)
}

/** 左/右各出屏多少（正值 = 露在屏幕外的宽度） */
export function offscreenOf(workArea: Rect, rect: Rect): { left: number; right: number } {
  return {
    left: Math.max(0, workArea.x - rect.x),
    right: Math.max(0, rect.x + rect.width - (workArea.x + workArea.width))
  }
}

/**
 * 形态判定（纯函数，04 §5.2 v0.31）：
 * - 长条态：`gap > 48` → `expand`；否则 `none`
 * - 面板态：左/右出屏 > 宽度 1/3 → 收长条并贴该边；否则 `none`（允许半挂在屏外）
 */
export function resolveDragStep(mode: HudMode, workArea: Rect, rect: Rect): DragStep {
  if (mode === 'ball') return edgeGap(workArea, rect) > EDGE_EXPAND ? 'expand' : 'none'

  const { left, right } = offscreenOf(workArea, rect)
  const limit = rect.width * PANEL_COLLAPSE_RATIO
  if (left > limit && left >= right) return 'collapse-left'
  if (right > limit) return 'collapse-right'
  return 'none'
}

/* ------------------------------------------------------------------ *
 * 运行时
 * ------------------------------------------------------------------ */

interface Layout {
  mode: HudMode
  displayId: number
  workArea: Rect
  /** 当前形态下窗口左上角（球的左上角 / 面板的左上角） */
  anchor: Point
  size: HudSize
}

let port: HudWindowPort | null = null
let displays: HudDisplaysPort | null = null
let state: HudState | null = null
/** 当前窗口左上角（形态切换时按目标形态重算，跨形态只记这一个点） */
let anchor: Point = { x: 0, y: 0 }
/** 面板尺寸（球态不使用，但保留：收球再展开要回到用户拉过的尺寸） */
let panelSize: HudSize = { ...DEFAULT_PANEL_SIZE }
/** 最近一次程序化 setBounds 的目标：`move` 回声按它丢弃 */
let expectedRect: Rect | null = null
let judgeTimer: ReturnType<typeof setTimeout> | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 本轮收尾里有没有"用户真的拉了窗口"。
 *
 * 只认 `resize` 事件：分数缩放下 `setBounds(360×480)` 回读是 361×481，
 * 若把每次收尾的读数都当作用户尺寸写回，展开/收球每往返一次就胖 1px（实测 361 → 363）。
 */
let sizeDirty = false

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

function clearTimers(): void {
  if (judgeTimer) {
    clearTimeout(judgeTimer)
    judgeTimer = null
  }
  if (settleTimer) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
}

/**
 * 库里的形态串归一：`dock-bar` / `float-pod`（v0.21 遗留）/ 任何未知串 → `ball`。
 * 旧值不迁库、不留兼容分支——只在读的时候归一。
 */
function normalizeMode(raw: unknown): HudMode {
  return raw === 'panel' ? 'panel' : 'ball'
}

function pointFor(mode: HudMode, workArea: Rect, size: HudSize, point: Point): Point {
  if (mode === 'ball') return clampBallPoint(workArea, point)
  const rect = clampInto(workArea, { ...point, ...size })
  return { x: rect.x, y: rect.y }
}

/**
 * 面板 bounds：纵向 clamp 进工作区，**横向按原值**。
 *
 * v0.31 放宽横向：面板允许半挂在屏幕外（出屏 ≤ 宽 1/3 时保持不动），这里若整体 clamp
 * 就会把用户拖出去的面板弹回屏内，「1/3 以内不动」的行为根本看不到。
 * 出屏 > 1/3 的情况在判形态时已经收成长条，走不到这里。
 */
function panelBounds(workArea: Rect, size: HudSize, point: Point): Rect {
  const full = clampInto(workArea, { ...point, width: size.width, height: size.height })
  return { x: Math.round(point.x), y: full.y, width: full.width, height: full.height }
}

function boundsFor(
  mode: HudMode,
  workArea: Rect,
  size: HudSize,
  point: Point
): Rect {
  return mode === 'ball' ? ballBounds(workArea, point) : panelBounds(workArea, size, point)
}

/** 从 settings 还原一次完整布局（启动时用，`hud.displayId` 找不到屏即回落主屏） */
function resolveLayout(displayPort: HudDisplaysPort): Layout {
  const area = displayPort.workAreaOf(settingRepo.get('hud.displayId'))
  const mode = normalizeMode(settingRepo.get('hud.mode'))
  const size = fitSize(area.workArea, settingRepo.get('hud.size') ?? DEFAULT_PANEL_SIZE)
  const stored = settingRepo.get('hud.position')

  const anchor =
    stored.x === null || stored.y === null
      ? pointFor(mode, area.workArea, size, initialBallPoint(area.workArea))
      : pointFor(mode, area.workArea, size, { x: stored.x, y: stored.y })

  return { mode, displayId: area.displayId, workArea: area.workArea, anchor, size }
}

/** 建窗之前先算初始 bounds（windowManager 用它创建 BrowserWindow，避免先建再挪的闪烁） */
export function resolveInitialBounds(displayPort: HudDisplaysPort): Rect {
  const layout = resolveLayout(displayPort)
  return boundsFor(layout.mode, layout.workArea, layout.size, layout.anchor)
}

/** 按形态设窗口能力：面板可拉伸 + 尺寸上下限；长条固定 132×40（04 §5.1） */
function applyWindowMode(mode: HudMode): void {
  const target = requirePort()
  target.setMovable(true)
  if (mode === 'panel') {
    target.setResizable(true)
    target.setMinSize(PANEL_MIN_W, PANEL_MIN_H)
    target.setMaxSize(PANEL_MAX_W, PANEL_MAX_H)
    return
  }
  // 先放开下限再缩到长条：带 minWidth=280 的窗口 setBounds 到 132 会被系统夹住（40 高更会被 320 夹）
  target.setMinSize(0, 0)
  target.setMaxSize(0, 0)
  target.setResizable(false)
}

function applyBounds(): void {
  const current = requireState()
  const area = requireDisplays().workAreaOf(current.displayId)
  const next = boundsFor(current.mode, area.workArea, panelSize, anchor)
  current.bounds = next
  // 先记目标再 setBounds：窗口回抛的 move 是回声，不能当作拖动
  expectedRect = next
  requirePort().setBounds(next)
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

function persistSize(size: HudSize): void {
  const stored = settingRepo.get('hud.size')
  if (!stored || stored.width !== size.width || stored.height !== size.height) {
    settingRepo.set('hud.size', { width: size.width, height: size.height })
  }
}

/** 形态落地：换 bounds + 能力 + 落库 + 广播。**不重建窗口**（04 §5.2）。 */
function enterMode(mode: HudMode, area: HudDisplayArea, point: Point): void {
  const current = requireState()
  current.mode = mode
  current.displayId = area.displayId
  anchor = pointFor(mode, area.workArea, panelSize, point)

  applyWindowMode(mode)
  applyBounds()
  settingRepo.set('hud.mode', mode)
  persistPosition(anchor)
  persistDisplayId(area.displayId)
  broadcast({ type: 'hud.mode.changed', mode })
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
    visible: true,
    displayId: layout.displayId,
    bounds: boundsFor(layout.mode, layout.workArea, layout.size, layout.anchor)
  }
  anchor = layout.anchor
  panelSize = layout.size

  applyWindowMode(layout.mode)
  applyBounds()
  windowPort.onMove(handleWindowMove)
  windowPort.onResize(handleWindowResize)

  // 记忆的显示器不在了（拔屏）：把回落结果写回，下次重启不再找旧屏
  persistDisplayId(layout.displayId)
}

/** 卸载端口（窗口销毁时调用；测试里也用它隔离用例） */
export function detach(): void {
  clearTimers()
  port = null
  displays = null
  state = null
  anchor = { x: 0, y: 0 }
  panelSize = { ...DEFAULT_PANEL_SIZE }
  expectedRect = null
  sizeDirty = false
}

/**
 * `move` 入口：回声丢弃 + 两条去抖。
 *
 * 回声判定比 x/y，且**容忍 `ECHO_TOLERANCE`**（分数缩放下 setBounds 回读差 1–2px，
 * 精确等值会让自己的回声被当成拖动 → 窗口自我漂移）。吞掉后不排判定，否则"展开即收"会自激。
 */
function handleWindowMove(): void {
  if (!port || !state) return
  const rect = port.getBounds()

  if (
    expectedRect &&
    Math.abs(rect.x - expectedRect.x) <= ECHO_TOLERANCE &&
    Math.abs(rect.y - expectedRect.y) <= ECHO_TOLERANCE
  ) {
    // 不清 expectedRect：一次 setBounds 会先后抛 move 和 resize，清早了 resize 那条就漏网
    return
  }
  expectedRect = null

  if (judgeTimer) clearTimeout(judgeTimer)
  judgeTimer = setTimeout(judgeShape, MOVE_JUDGE_MS)
  scheduleSettle()
}

/**
 * `resize` 入口：**自己 setBounds 引起的 resize 也必须吞掉**。
 *
 * 无边框可拉伸窗口在 Windows 上带一圈隐形边框：请求 360×480，回读 361×481。
 * 若把这类 resize 也算成"用户拉伸"，下一次展开就按 361 请求 → 回读 362 → 每开一次胖 1px
 * （实测 377→378→379→380）。判定与 move 同口径：与程序化目标差在 `ECHO_TOLERANCE` 内即回声。
 */
function handleWindowResize(): void {
  if (!port || !state) return
  const rect = port.getBounds()
  if (
    expectedRect &&
    Math.abs(rect.width - expectedRect.width) <= ECHO_TOLERANCE &&
    Math.abs(rect.height - expectedRect.height) <= ECHO_TOLERANCE
  ) {
    return
  }
  sizeDirty = true
  scheduleSettle()
}

function scheduleSettle(): void {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(settle, SETTLE_MS)
}

/** 拖动中去抖判形态（04 §5.2 第 2 条）：命中就当场变形 */
function judgeShape(): void {
  judgeTimer = null
  if (!port || !state) return

  const rect = port.getBounds()
  const area = requireDisplays().nearestWorkArea(rect)
  const step = resolveDragStep(state.mode, area.workArea, rect)
  if (step === 'none') return

  if (step === 'expand') {
    const next = peekPanelBounds(area.workArea, { x: rect.x, y: rect.y }, panelSize)
    enterMode('panel', area, { x: next.x, y: next.y })
    return
  }

  const side = step === 'collapse-left' ? 'left' : 'right'
  enterMode('ball', area, ballFromPanel(area.workArea, rect, side))
}

/**
 * 拖动 / 拉伸收尾：先补判一次形态（快拖快放不到 `MOVE_JUDGE_MS`），再读真值、落库（位置 + 尺寸 + 屏）。
 * 尺寸只在面板态落 `hud.size`（长条 132×40 是常量，不该覆盖用户拉过的面板尺寸）。
 */
function settle(): void {
  settleTimer = null
  if (!port || !state) return

  const rect = port.getBounds()
  const area = requireDisplays().nearestWorkArea(rect)

  // move 的形态判定是 120ms 去抖：拖出去立刻松手可能还没跑到，这里补一次。
  // enterMode 内部已经 persistPosition / persistDisplayId / broadcast，不要重复落库。
  const step = resolveDragStep(state.mode, area.workArea, rect)
  if (step === 'expand') {
    const next = peekPanelBounds(area.workArea, { x: rect.x, y: rect.y }, panelSize)
    enterMode('panel', area, { x: next.x, y: next.y })
    return
  }
  if (step === 'collapse-left' || step === 'collapse-right') {
    const side = step === 'collapse-left' ? 'left' : 'right'
    enterMode('ball', area, ballFromPanel(area.workArea, rect, side))
    return
  }

  // 面板态：只有用户真的拉了窗口（resize 事件）才更新 panelSize。
  // 顺序也重要——先把尺寸收进来再算 bounds，否则会把刚拉大的窗口按旧尺寸 setBounds 回去。
  const resized = state.mode === 'panel' && sizeDirty
  if (resized) {
    panelSize = fitSize(area.workArea, { width: rect.width, height: rect.height })
  }
  sizeDirty = false
  const clamped = boundsFor(state.mode, area.workArea, panelSize, { x: rect.x, y: rect.y })

  state.displayId = area.displayId
  anchor = { x: clamped.x, y: clamped.y }

  persistPosition(anchor)
  persistDisplayId(area.displayId)
  if (resized) persistSize(panelSize)

  const moved =
    Math.abs(clamped.x - rect.x) > ECHO_TOLERANCE ||
    Math.abs(clamped.y - rect.y) > ECHO_TOLERANCE ||
    Math.abs(clamped.width - rect.width) > ECHO_TOLERANCE ||
    Math.abs(clamped.height - rect.height) > ECHO_TOLERANCE
  if (moved) applyBounds()
  else state.bounds = clamped
}

/** 手动切换形态（点长条展开 / ESC 收回）：换 bounds + 广播，窗口不重建 */
export function setMode(mode: HudMode): void {
  const current = requireState()
  if (current.mode === mode) return

  const area = requireDisplays().workAreaOf(current.displayId)
  if (mode === 'panel') {
    const next = peekPanelBounds(area.workArea, anchor, panelSize)
    enterMode('panel', area, { x: next.x, y: next.y })
    return
  }
  enterMode('ball', area, clampBallPoint(area.workArea, anchor))
}

/** 程序化移动（clamp + 落库；不参与实时变形判定——判定只认用户拖动产生的 move） */
export function moveTo(x: number, y: number): void {
  const current = requireState()
  const area = requireDisplays().nearestWorkArea({
    x,
    y,
    width: current.mode === 'ball' ? BALL_W : panelSize.width,
    height: current.mode === 'ball' ? BALL_H : panelSize.height
  })

  anchor = pointFor(current.mode, area.workArea, panelSize, { x, y })
  current.displayId = area.displayId
  persistPosition(anchor)
  persistDisplayId(area.displayId)
  applyBounds()
}

/**
 * 长条态拖动（04 §5.2.2 v0.32：点按展开 / 长按拖动）。
 *
 * 渲染层只发**相对上一帧的位移**（`screenX/Y` 差值），坐标与形态判定全在这里：
 * - 整条不出屏：位移后的落点仍过 `clampBallPoint`（v0.31 既定口径）；
 * - `end:false` 只移窗、**不落库**——拖到一半就写 `hud.position` 会让下次启动停在半路；
 * - `end:true` 才落库并判一次形态：离左右边 > 48 → 展开成面板（走 `enterMode`，不自己 setBounds）。
 * - 面板态直接忽略：面板走 `.hud-head` 的原生拖动，这条路只服务长条。
 */
export function dragBy(dx: number, dy: number, end: boolean): void {
  const current = requireState()
  if (current.mode !== 'ball') return
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return

  const rect = requirePort().getBounds()
  const area = requireDisplays().nearestWorkArea(rect)
  anchor = clampBallPoint(area.workArea, {
    x: rect.x + Math.round(dx),
    y: rect.y + Math.round(dy)
  })
  current.displayId = area.displayId

  if (!end) {
    // applyBounds 内部设 expectedRect：窗口回抛的 move 是回声，不会触发 judgeShape
    applyBounds()
    return
  }

  persistPosition(anchor)
  persistDisplayId(area.displayId)

  // 松手才判形态（拖动中窗口变大 = 指针相对位置突变 = 手感跳）
  const step = resolveDragStep('ball', area.workArea, {
    x: anchor.x,
    y: anchor.y,
    width: BALL_W,
    height: BALL_H
  })
  if (step === 'expand') {
    const panel = peekPanelBounds(area.workArea, anchor, panelSize)
    enterMode('panel', area, { x: panel.x, y: panel.y })
    return
  }
  applyBounds()
}

export function setVisible(visible: boolean): void {
  const current = requireState()
  const target = requirePort()
  current.visible = visible
  // 载荷是**目标值**，不是 `win.isVisible()` 回读——回读在 show/hide 完成前还是旧值，开关会闪一下。
  // 没有这条广播，主窗顶栏就与主进程脱钩（设置页关掉 HUD 后开关仍显示"开"，点第一次没反应）。
  broadcast({ type: 'hud.visible.changed', visible })
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
  displayId: number
  visible: boolean
} {
  const current = requireState()
  return {
    mode: current.mode,
    displayId: current.displayId,
    visible: current.visible && !requirePort().isDestroyed()
  }
}

/**
 * 显示器配置变化（`display-removed` / `display-metrics-changed`）后重算：
 * 记忆的屏不在了回落主屏，工作区变小则把尺寸与坐标都收回来，最后重新 setBounds。
 */
export function syncDisplays(): void {
  const current = requireState()
  const area = requireDisplays().workAreaOf(current.displayId)

  current.displayId = area.displayId
  panelSize = fitSize(area.workArea, panelSize)
  anchor = pointFor(current.mode, area.workArea, panelSize, anchor)

  persistDisplayId(area.displayId)
  persistPosition(anchor)
  if (current.mode === 'panel') persistSize(panelSize)
  applyBounds()
}
