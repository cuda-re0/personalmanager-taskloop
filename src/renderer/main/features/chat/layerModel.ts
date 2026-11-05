import type { Message } from '@shared/types/domain'

/**
 * 会话区的两层（v0.69）：聊天层只放文字气泡，任务层只放任务卡。
 *
 * 分层规则只在这里写一处——`ChatPanel` 只负责按当前模式挑一层渲染，
 * 判定逻辑不散到组件里，将来加 kind 也只改这个文件。
 *
 * v0.69（72）起分层按**轮**判，不再只看单条 kind：任务模式那一轮里的文字也归任务层，
 * 见 `layersOfMessages`。`layerOfKind` 仍只负责单条的**基础层**。
 *
 * v0.73（73）：消息带上发送模式标签（`messages.mode`）——**有标签的按标签**（`layerOfMessage`），
 * **没标签的（v0.73 之前的老行，`mode === null`）按轮推断兜底**（`layersOfMessages` 第二段）。
 */
export type ChatLayer = 'chat' | 'task'

/** 消息 meta 的 kind——直接取领域类型，不另抄一份联合（抄了就会漏改） */
export type MessageMetaKind = Message['meta']['kind']

/**
 * 一条消息的基础层（v0.69）。
 *
 * 未知 / 未来新增的 kind 一律兜底到 `'chat'`：宁可多一条气泡，也不许把消息藏掉——
 * 藏掉的消息在界面上无迹可寻，比放错层严重得多。
 *
 * 形参交叉 `string` 是为了让"还没定义过的 kind"也能喂进来做兜底判断；
 * 已知的五个 kind 仍然有字面量补全，不退回 `any`。
 *
 * **轮规则不在这里**：整轮归任务层的判定见 `layersOfMessages`。
 */
export function layerOfKind(kind: MessageMetaKind | (string & Record<never, never>)): ChatLayer {
  switch (kind) {
    // 卡片与提醒都是任务的事，不是对话
    case 'task_draft':
    case 'task_review':
    case 'reminder':
      return 'task'
    // 纯文字、失败提示都属于对话本身
    case 'none':
    case 'error':
      return 'chat'
    default:
      return 'chat'
  }
}

/**
 * 轮标记（v0.69）：一轮里只要有草稿卡或审核卡，这一轮就是在建任务。
 *
 * `reminder` **不算**——它是任务通知，不代表这轮在跟 AI 建任务。
 */
function isTaskSignal(message: Message): boolean {
  const kind = message.meta.kind
  return kind === 'task_draft' || kind === 'task_review'
}

/**
 * 单条消息的层（v0.73）：**标签优先**。
 *
 * 1. 基础层是 `'task'`（卡片、提醒）→ `'task'`，不受 mode 影响；
 * 2. `mode === 'task'` → `'task'`（任务模式下哪怕这轮没出卡，文字也归任务层）；
 * 3. 其余（含 `mode === 'chat'` 与 `mode === null`）→ `'chat'`。
 */
export function layerOfMessage(message: Message): ChatLayer {
  if (layerOfKind(message.meta.kind) === 'task') return 'task'
  if (message.mode === 'task') return 'task'
  return 'chat'
}

/**
 * 按「轮」算每条消息的层（v0.69 / 72 §A2；v0.73 起改为标签优先 + 轮推断兜底）。
 *
 * 两段：
 * - **有标签**（`mode !== null`）：直接 `layerOfMessage`，标签优先于轮推断。
 * - **没标签**（v0.73 之前的老行）：跑轮推断——
 *   `role === 'user'` 开启新一轮，其后的消息（含 assistant）归入该轮，直到下一条 user；
 *   第一条 user 之前的消息**不属于任何轮**，只按基础层判；
 *   轮内有 `task_draft` / `task_review` → 本轮标记为 task（`reminder` 不算）；
 *   基础层是 `'chat'` 且所属轮被标记 → 改判 `'task'`，基础层本来就是 `'task'` 的永远是 task。
 *   轮切分仍遍历**全部**消息，只是不给有标签的重新赋值——跳过会让轮边界错位。
 *
 * 入参必须是**全量**消息（含被可见性过滤藏起来的审核卡）：没标签的老轮里，某轮唯一的
 * 任务信号恰好是那张被藏起来的卡时，只看可见数组会把整轮错判进聊天层。
 *
 * 返回 `消息 id → 层`，每条消息都有键。
 */
export function layersOfMessages(messages: readonly Message[]): Map<string, ChatLayer> {
  const layers = new Map<string, ChatLayer>()

  // 第一段：有标签的按标签
  for (const message of messages) {
    if (message.mode !== null) layers.set(message.id, layerOfMessage(message))
  }

  /** 第二段：只给没标签的消息落层（有标签的已被第一段定死，不许覆盖） */
  const assignLegacy = (message: Message, turnMarked: boolean): void => {
    if (message.mode !== null) return
    const base = layerOfKind(message.meta.kind)
    layers.set(message.id, base === 'chat' && turnMarked ? 'task' : base)
  }
  const flush = (turn: readonly Message[]): void => {
    const marked = turn.some(isTaskSignal)
    for (const message of turn) assignLegacy(message, marked)
  }

  let turn: Message[] = []
  let inTurn = false
  for (const message of messages) {
    if (message.role === 'user') {
      // 上一条 user 起到这里的消息是一整轮，先结掉再开新轮
      if (inTurn) flush(turn)
      turn = []
      inTurn = true
    }
    if (!inTurn) {
      // 第一条 user 之前的消息不属于任何轮，只按基础层判
      assignLegacy(message, false)
      continue
    }
    turn.push(message)
  }
  if (inTurn) flush(turn)

  return layers
}

/**
 * 按层过滤（v0.69）：保持原顺序，不重排、不去重——顺序是会话的时间线，不许动。
 *
 * `layers` 由 `layersOfMessages(全量消息)` 算出，`visible` 传当前可见的消息。
 * 取不到层（不在 Map 里）就回退单条基础层，**不许吞消息**。
 */
export function messagesOfLayer(
  visible: readonly Message[],
  layers: ReadonlyMap<string, ChatLayer>,
  layer: ChatLayer
): Message[] {
  return visible.filter(
    message => (layers.get(message.id) ?? layerOfKind(message.meta.kind)) === layer
  )
}
