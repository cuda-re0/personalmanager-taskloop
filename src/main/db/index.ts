/**
 * 数据库入口（W0 留的接线点，被 `src/main/index.ts` 调用，`initDb` 的名字与调用方式不能改）。
 *
 * 这一层对外只暴露：连接/事务、七个 repo、occurrence 生成、状态机、日历与统计查询。
 * 业务编排（积分发放、证据闸门、AI 审核）在 services/ 与后续波次里做。
 */
export {
  initDb,
  openDb,
  closeDb,
  getDb,
  isOpen,
  tx,
  migrate,
  applyPragmas,
  getUserVersion
} from './connection'
export type { Db } from './connection'

export { assertTransition, isTransitionAllowed } from './stateMachine'
export { AppErrorException, appError, isConstraintError } from './errors'
export * from './localDay'
export { DEFAULT_SETTINGS, SETTING_KEYS } from './defaultSettings'
export { newId } from './ids'

export * as taskRepo from './repositories/taskRepo'
export * as occurrenceRepo from './repositories/occurrenceRepo'
export * as messageRepo from './repositories/messageRepo'
export * as ledgerRepo from './repositories/ledgerRepo'
export * as reminderRepo from './repositories/reminderRepo'
export * as statsRepo from './repositories/statsRepo'
export * as settingRepo from './repositories/settingRepo'

export {
  ensureRange as ensureOccurrences,
  listToday as listTodayOccurrences,
  listRange as listOccurrencesByRange,
  markMissedBefore,
  repeatDaysOf
} from './occurrenceService'
