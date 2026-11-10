import { useEffect, useState } from 'react'
import type { Task, TaskStatus } from '@shared/types/domain'

/**
 * 计划面板的数据入口（92a §2.2）。
 *
 * 六个状态**必须显式传全**：`taskRepo.list` 不给 `status` 时默认只返回
 * `todo / doing / pending_review / reviewing` 四个活跃态，已完成的历史条目会从计划里消失
 * ——而「整份计划哪天分了什么」恰恰需要连做完的一起看。
 *
 * 之后靠 DomainEvent 全量重拉（与 `useTasksData` 同口径）：单窗口、带计划日的任务量级小，
 * 重拉比维护一套本地 diff 简单且不会漂。
 *
 * 不设 loading 态、不写错误 UI（项目惯例：无数据留白），失败只记控制台。
 */

const PLAN_STATUS: TaskStatus[] = [
  'todo',
  'doing',
  'pending_review',
  'reviewing',
  'done',
  'missed'
]

export function usePlanData(): { tasks: Task[] } {
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    let alive = true

    const load = (): void => {
      void window.api.task
        .list({ status: PLAN_STATUS })
        .then(res => {
          if (!alive) return
          if (!res.ok) {
            console.error('[plan] task.list 失败', res.error)
            return
          }
          setTasks(res.data)
        })
        .catch((e: unknown) => {
          if (alive) console.error('[plan] task.list 调用失败', e)
        })
    }

    load()
    const off = window.api.onEvent(event => {
      if (event.type.startsWith('task.')) load()
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  return { tasks }
}
