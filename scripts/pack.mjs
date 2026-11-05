#!/usr/bin/env node
/**
 * `npm run pack` 的宿主：把当前构建产物装进绿色版的 `updates/` 目录，供启动自检使用。
 *
 * 前置：先 `npm run build`（本脚本不负责构建，build 是自检用的，不该顺手改 dist）。
 *
 * 产物结构（与 updateService 的口径一一对应）：
 *   dist/taskloop/updates/latest.json   {"version":"x.y.z"}       —— 只比版本号
 *   dist/taskloop/updates/app/out/**    替换源：覆盖到 resources/app/out
 *   dist/taskloop/updates/app/package.json  版本号来源，必须一起替换
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'dist', 'taskloop', 'updates')

function fail(message) {
  console.error(message)
  process.exit(1)
}

/** 递归拷目录。手写而不是 `fs.cpSync`：后者在本机这套 node/沙箱下会静默杀进程（退出码 127） */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dst)
    else if (entry.isFile()) copyFileSync(src, dst)
  }
}

let version = ''
try {
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
} catch (e) {
  fail(`[pack] 读不到 package.json 的 version：${e instanceof Error ? e.message : String(e)}`)
}
if (typeof version !== 'string' || version.trim() === '') {
  fail('[pack] package.json 的 version 是空的，先填版本号再打包')
}
if (version === '0.0.0') {
  fail('[pack] package.json 的 version 还是 0.0.0，先改版本号再打包')
}

// 整个删掉重建：留着上一版的残留文件，等于把新旧两版混在一起覆盖
rmSync(target, { recursive: true, force: true })
mkdirSync(join(target, 'app'), { recursive: true })

copyTree(join(root, 'out'), join(target, 'app', 'out'))
copyFileSync(join(root, 'package.json'), join(target, 'app', 'package.json'))
writeFileSync(join(target, 'latest.json'), `${JSON.stringify({ version }, null, 2)}\n`, 'utf8')

console.log(`updates ready: ${version}`)
