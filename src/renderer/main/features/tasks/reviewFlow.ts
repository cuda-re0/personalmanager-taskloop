import type { Message, ReviewVerdict, Task } from '@shared/types/domain'
import type { Api } from '@shared/types/ipc'

/**
 * 完成审核的分流（v0.34~v0.36，04 §3.3 / 01 §3）。
 *
 * 这里是**分流规则的唯一实现**：① 的完成链路（`useTasksData`）与聊天卡的重审
 * （`useChatData`）都只调 `runReview`，不许在别处再抄一份 `pass/partial/fail` 判断。
 *
 * 两条硬约束（施工词 33 §3.2）：
 * - 只有 `pass` 计分；`partial` 与 `fail` 的**流转完全一样**（回 doing，或超期判 missed），
 *   差别只在卡片展示（gaps / reason）。
 * - 任何失败（AI 挂、落库挂）都必须把任务从 `reviewing` 里捞出来：`pass` 卡在 v0.35 起
 *   没有按钮，留在 `reviewing` 就是死锁。
 */

/**
 * 取 preload 暴露的 API。
 *
 * 不用 `window.api` 直接写：这个模块要能被 `tsconfig.test.json`（只带 ES2022、没有 DOM）
 * 编译，`window` 这个标识符在那里不存在。渲染进程里 `globalThis === window`，两者等价。
 */
function api(): Api {
  return (globalThis as unknown as { api: Api }).api
}

/** 一张卡/一次提交的下一步动作（`decideReview` 的返回值，纯数据） */
export type ReviewDecision = 'complete' | 'revive' | 'missed' | 'stay'

export type ReviewRunResult =
  | { kind: 'done'; verdict: ReviewVerdict }
  | { kind: 'error'; message: string }
  /** 同一任务已有一次审核在飞（并发闸命中），本次什么也没做 */
  | { kind: 'skipped' }

/** 正在审核的任务（模块级并发闸：双击/两张卡同时点也只发一次请求） */
const inFlight = new Set<string>()

/**
 * 超期判定（只给「驳回后是否判失败」用）。
 *
 * - `dueAt` 为 null / 解析成 NaN：一律不算超期（回 doing 可再提交）
 * - `dueAt` 恰好等于 now：**不算**超期（用严格小于，边界归用户）
 */
function isOverdue(dueAt: string | null, now: Date): boolean {
  if (dueAt === null) return false
  const due = Date.parse(dueAt)
  if (Number.isNaN(due)) return false
  return due < now.getTime()
}

/**
 * verdict + 任务 → 下一步动作。**纯函数**，`now` 显式传入，测试直接调。
 */
export function decideReview(
  verdict: ReviewVerdict,
  task: Pick<Task, 'dueAt'>,
  now: Date
): ReviewDecision {
  if (verdict.verdict === 'pass') return 'complete'
  if (verdict.verdict === 'need_evidence') return 'stay'
  // partial / fail：流转一致，只有卡片展示不同
  return isOverdue(task.dueAt, now) ? 'missed' : 'revive'
}

/**
 * 连续 `need_evidence` 次数（04 §3.3 的「连续 3 次后出现不计分出口」）。
 *
 * 从**最后一条**往前数，只数该任务的 `task_review` 消息，遇到第一条不是
 * `need_evidence` 的立即停——`pass` / `partial` / `fail` 都会把计数清零。
 */
export function countNeedEvidence(messages: Message[], taskId: string): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const meta = messages[i].meta
    if (meta.kind !== 'task_review' || meta.taskId !== taskId) continue
    if (meta.verdict.verdict !== 'need_evidence') break
    count += 1
  }
  return count
}

/**
 * 待提交列表的合成（v0.38 §7）：主进程真值 ∪ 提交中快照，按 `updatedAt` 升序（先进的在上）。
 *
 * 为什么要把提交中的任务留在列表里：点提交后任务立刻变成 `reviewing`，如果只认主进程真值，
 * 卡片会在 transition 成功的那一刻消失，用户在等 AI 的几秒里看不到任何东西。
 * 纯函数，导出让测试直接断言排序与「已变 reviewing 仍在列表」。
 */
export function mergePendingSubmit(
  pending: Task[],
  submitting: Record<string, Task>
): Task[] {
  const map = new Map<string, Task>()
  for (const task of pending) map.set(task.id, task)
  for (const [id, task] of Object.entries(submitting)) if (!map.has(id)) map.set(id, task)
  return [...map.values()].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
}

/**
 * 提交审核（v0.38 §5）：待提交卡上的 `[提交]` 走这里，**组件里不许自己拼这两步**。
 *
 * ```
 * transition({to:'reviewing'})  →  成功才 runReview  →  分流全在 runReview 里
 * ```
 *
 * 三条边界：
 * - 零证据直接返回 null（不提交、不报错）：按钮侧本就 `disabled`，这里是兜底，
 *   免得主进程抛 `EVIDENCE_REQUIRED` 变成一句用户看不懂的红字。
 * - `transition` 失败 → 返回错误原文并**不调 AI**（任务还没进审核，调了就是白发一次请求）。
 * - `runReview` 失败 → 它自己已经把任务从 `reviewing` 捞回 `doing`，这里只透传原文。
 */
export async function submitForReview(taskId: string): Promise<string | null> {
  try {
    const loaded = await api().task.get({ id: taskId })
    if (!loaded.ok) return loaded.error.message
    if (loaded.data.evidence.length === 0) return null

    const moved = await api().task.transition({ id: taskId, to: 'reviewing' })
    if (!moved.ok) return moved.error.message

    const result = await runReview(taskId)
    return result.kind === 'error' ? result.message : null
  } catch (e: unknown) {
    return messageOf(e)
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}

/**
 * 失败兜底：任务还在 `reviewing` 就 best-effort 回 `doing`。
 *
 * 第 3 步（AI 挂）与第 4 步（落库挂）**必须共用这一个 helper**——两处各写一遍迟早漂。
 * 失败只记日志：已经有一个更重要的错误要显示，不要再叠一条。
 */
async function reviveToDoing(taskId: string): Promise<void> {
  try {
    const current = await api().task.get({ id: taskId })
    if (!current.ok || current.data.status !== 'reviewing') return
    const moved = await api().task.transition({ id: taskId, to: 'doing' })
    if (!moved.ok) console.warn('[review] 回退到进行中失败', moved.error)
  } catch (e: unknown) {
    console.warn('[review] 回退到进行中调用失败', e)
  }
}

/** 流转失败不弹错（页面已经不在那个状态了，重取后会自己对齐） */
async function transitionQuietly(taskId: string, to: 'doing' | 'missed'): Promise<void> {
  try {
    const moved = await api().task.transition({ id: taskId, to })
    if (!moved.ok) console.warn(`[review] transition(${to}) 失败`, moved.error)
  } catch (e: unknown) {
    console.warn(`[review] transition(${to}) 调用失败`, e)
  }
}

/**
 * 提交即送审：`ai.review` → 按 verdict 分流（施工词 33 §3.4）。
 *
 * 返回 `error` 时任务**一定**已不在 `reviewing`（能捞就捞回来了），调用方只需把
 * `message` 原样显示，不要自己再补句子。
 */
export async function runReview(taskId: string, now: Date = new Date()): Promise<ReviewRunResult> {
  if (inFlight.has(taskId)) return { kind: 'skipped' }
  inFlight.add(taskId)
  try {
    const loaded = await api().task.get({ id: taskId })
    if (!loaded.ok) return { kind: 'error', message: loaded.error.message }

    const reviewed = await api().ai.review({ taskId })
    if (!reviewed.ok) {
      // AI 挂（未配置 key / 网络 / 超时 / 模型报错）：任务不许卡在 reviewing
      await reviveToDoing(taskId)
      return { kind: 'error', message: reviewed.error.message }
    }

    const verdict = reviewed.data

    /**
     * 迟到的审核结果不执行流转（v0.41 §5）。
     *
     * 调 AI 是一个 5–30s 的窗口，这期间任务可能已经被取消、被 sweeper 退回、或者被别的
     * 窗口改走。`loaded.data` 是**调 AI 之前**的快照，拿它决定 complete/revive 会让一个
     * 迟到的 `pass` 给已经不在 `reviewing` 的任务发分。所以这里必须重读一次。
     */
    const after = await api().task.get({ id: taskId })
    if (!after.ok) {
      console.warn('[review] AI 返回后重读任务失败，本次不流转', taskId, after.error)
      return { kind: 'skipped' }
    }
    if (after.data.status !== 'reviewing') {
      console.warn('[review] AI 返回时任务已不在待确认，本次不流转', taskId, after.data.status)
      return { kind: 'skipped' }
    }

    const decision = decideReview(verdict, loaded.data, now)

    if (decision === 'complete') {
      // event 的分只看 result（02 §5），quality 恒传 met；deadline 用 AI 判的档
      const input =
        loaded.data.type === 'event'
          ? { id: taskId, quality: 'met' as const, result: verdict.result ?? ('met' as const) }
          : { id: taskId, quality: verdict.quality ?? ('met' as const) }
      const done = await api().task.complete(input)
      if (!done.ok) {
        // 落库挂（CONFLICT / DB 错）：与 AI 挂走同一条兜底，pass 卡没有按钮，留下就是死锁
        await reviveToDoing(taskId)
        return { kind: 'error', message: done.error.message }
      }
      return { kind: 'done', verdict }
    }

    if (decision === 'revive') {
      await transitionQuietly(taskId, 'doing')
      return { kind: 'done', verdict }
    }

    if (decision === 'missed') {
      await transitionQuietly(taskId, 'missed')
      return { kind: 'done', verdict }
    }

    // need_evidence：不流转，停在 reviewing，等用户补证据后重审
    return { kind: 'done', verdict }
  } catch (e: unknown) {
    await reviveToDoing(taskId)
    return { kind: 'error', message: messageOf(e) }
  } finally {
    inFlight.delete(taskId)
  }
}
