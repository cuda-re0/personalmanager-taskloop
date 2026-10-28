/**
 * 数据库入口。
 * W0 只留接线点：`src/main/index.ts` 已调用 `initDb()`，W1 在这个函数里填实现
 * （单例连接、WAL、foreign_keys=ON、migrate()），不需要改 `src/main/index.ts`。
 */
export function initDb(): void {
  // TODO(W1): 建立 better-sqlite3 单例连接并执行迁移
}
