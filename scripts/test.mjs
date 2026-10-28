#!/usr/bin/env node
/**
 * `npm test` 的宿主进程。
 *
 * 为什么不用裸 `vitest run`：better-sqlite3 被 postinstall 的 electron-rebuild
 * 编成了 Electron ABI（当前 130），而系统 node 的 ABI 不同（22.x 是 127），
 * 直接跑会在 `new Database()` 时抛 ERR_DLOPEN_FAILED。
 *
 * 用 Electron 内置的 node 跑还有个额外好处：测试和生产跑的是同一个二进制，
 * 不必为了测试再维护一份 node-ABI 产物。
 *
 * 串行（--no-file-parallelism）是实测需要：并行 worker 下偶尔出现
 * EPERM ...\Temp\...\ssr\... 导致汇总里丢文件。串行 90 条约 6 秒，不值得冒险。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const electron = join(
  root,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')

for (const [label, path] of [
  ['electron', electron],
  ['vitest', vitest]
]) {
  if (!existsSync(path)) {
    console.error(`[test] 缺少 ${label}: ${path}`)
    console.error('[test] 先执行 npm install')
    process.exit(1)
  }
}

const child = spawn(electron, [vitest, 'run', '--no-file-parallelism', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

child.on('error', err => {
  console.error('[test] 启动失败:', err.message)
  process.exit(1)
})

child.on('exit', code => process.exit(code ?? 1))
