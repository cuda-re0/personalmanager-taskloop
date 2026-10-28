import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDb, openDb } from '../../src/main/db/connection'

/** 内存库：每个用例一份干净库，最快 */
export function openMemoryDb(): void {
  openDb(':memory:')
}

/** 临时文件库：要断言 WAL / 落盘行为时用它；用完删掉这次创建的临时目录 */
export function openTempFileDb(tag = 'taskloop-test'): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${tag}-`))
  const file = join(dir, 'test.db')
  openDb(file)
  return {
    file,
    cleanup: () => {
      closeDb()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function closeTestDb(): void {
  closeDb()
}

/** 断言抛出的 AppError 的 code（02 §1.2 的错误码集合） */
export function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (e) {
    thrown = e
  }
  if (thrown === undefined) throw new Error(`预期抛出 ${code}，实际没有抛错`)
  const actual = (thrown as { code?: string }).code
  if (actual !== code) {
    throw new Error(`预期错误码 ${code}，实际 ${String(actual)}（${(thrown as Error).message}）`)
  }
}
