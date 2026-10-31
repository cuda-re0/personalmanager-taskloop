import initSql from './001_init.sql?raw'
import ledgerReversedSql from './002_ledger_reversed.sql?raw'
import chatSql from './003_chat.sql?raw'
import spendSql from './004_spend.sql?raw'

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
  { version: 4, name: '004_spend', sql: spendSql }
]
