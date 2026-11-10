import type { ReactElement } from 'react'
import type { Task } from '@shared/types/domain'
import { floorTitle } from '../calendar/calendarModel'
import { groupByPlanDay } from './planModel'
import { usePlanData } from './usePlanData'
import './plan.css'

/**
 * 「计划面板」（92a §2.3）：顶栏点「计划」后，右栏下半整块换成按天铺开的只读列表。
 *
 * 结构写死：一天一个 `section`，组头用 `floorTitle`（与日历同一份格式化，不另写），
 * 组内一行一条任务，**只有标题**——不加类型标签、不加日期、不加按钮、不加状态文字。
 *
 * 已完成的条目留在自己那一天，只是划掉压淡（`.plan-row--done`）；不移动、不隐藏。
 * 没有任何带计划日的任务时整块留白：不加空态文案、不加标题、不加计数（文案纪律）。
 *
 * 只读：不能改计划日、不能删除、不能点完成——所有操作仍在任务面板 / 待提交卡里。
 */

/** 已完成 / 已判失败：划掉压淡，但仍在原来那一天 */
function isDone(task: Task): boolean {
  return task.status === 'done' || task.status === 'missed'
}

export function PlanView(): ReactElement {
  const { tasks } = usePlanData()
  const groups = groupByPlanDay(tasks)

  return (
    <div className="plan-panel">
      {groups.map(g => (
        <section className="plan-day" key={g.day}>
          <div className="plan-day-head">{floorTitle(g.day)}</div>
          {g.tasks.map(t => (
            <div className={isDone(t) ? 'plan-row plan-row--done' : 'plan-row'} key={t.id}>
              {t.title}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
