import initSql from './001_init.sql?raw'
import ledgerReversedSql from './002_ledger_reversed.sql?raw'
import chatSql from './003_chat.sql?raw'
import spendSql from './004_spend.sql?raw'
import attachmentNameSql from './005_attachment_name.sql?raw'
import messageModeSql from './006_message_mode.sql?raw'
import pulseSql from './007_pulse.sql?raw'
import alertSql from './008_alert.sql?raw'
import messageSettledSql from './009_message_settled.sql?raw'
import taskPlannedDaySql from './010_task_planned_day.sql?raw'

/**
 * 迁移清单。只增不改（01 §5）。
 * 版本号即 `PRAGMA user_version`，文件里的序号必须与 version 对应。
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '001_init', sql: initSql },
  { version: 2, name: '002_ledger_reversed', sql: ledgerReversedSql },
  { version: 3, name: '003_chat', sql: chatSql },
  { version: 4, name: '004_spend', sql: spendSql },
  { version: 5, name: '005_attachment_name', sql: attachmentNameSql },
  { version: 6, name: '006_message_mode', sql: messageModeSql },
  { version: 7, name: '007_pulse', sql: pulseSql },
  { version: 8, name: '008_alert', sql: alertSql },
  { version: 9, name: '009_message_settled', sql: messageSettledSql },
  { version: 10, name: '010_task_planned_day', sql: taskPlannedDaySql }
]
