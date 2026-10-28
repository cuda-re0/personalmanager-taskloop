/** 拼 SQL 的小工具（只为少写重复字符串，不承担任何映射职责） */

export type SqlParams = (string | number | bigint | null | Buffer)[]

export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

/** `{ a: 1, b: null }` → `{ clause: 'a = ?, b = ?', values: [1, null] }` */
export function buildSetClause(columns: Record<string, string | number | bigint | null | Buffer>): {
  clause: string
  values: SqlParams
} {
  const keys = Object.keys(columns)
  if (keys.length === 0) return { clause: '', values: [] }
  return {
    clause: keys.map(k => `${k} = ?`).join(', '),
    values: keys.map(k => columns[k])
  }
}
