import { randomBytes } from 'node:crypto'

/**
 * 契约里 ID 是 `nanoid(12)`（02 §1.5）。
 * 项目没有装 nanoid 包（dependencies 里只有 better-sqlite3 / react / react-dom，且 W1 不允许装包），
 * 这里用 node:crypto 生成同规格的 12 位 URL-safe 随机串：字母表与 nanoid 默认一致，熵相同。
 * 只保证"字符串、12 位、URL-safe"，渲染层本来就不该假设它是数字。
 */
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

export function newId(size = 12): string {
  const bytes = randomBytes(size)
  let out = ''
  for (let i = 0; i < size; i += 1) {
    // 64 字母表 → 取低 6 位即可，掩码 63 与 alphabet.length - 1 相同
    out += ALPHABET[bytes[i] & 63]
  }
  return out
}
