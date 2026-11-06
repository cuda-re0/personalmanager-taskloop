#!/usr/bin/env node
/**
 * 87 单 · 生成 out/manifest.json（仓库即发行）。
 *
 * 由 npm run build 在 electron-vite build 之后调用。out/ 与清单一起入仓，
 * 客户端从 raw.githubusercontent.com 读这份清单，再按 files 串行下载 out/**。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'out')
const pkgFile = join(root, 'package.json')
const manifestFile = join(outDir, 'manifest.json')

/**
 * 与 src/main/update/updateService.ts 的 REQUIRED_FILES 同口径（这里相对 out/）。
 * 少了任何一个，客户端装完就是白屏，而且版本号已变、不会再自愈重装。
 */
const REQUIRED_FILES = [
  'main/index.js',
  'preload/index.js',
  'renderer/main/index.html',
  'renderer/hud/index.html',
  'renderer/notify/index.html'
]

function fail(message) {
  console.error(message)
  process.exit(1)
}

let version = ''
try {
  version = JSON.parse(readFileSync(pkgFile, 'utf8')).version
} catch (e) {
  fail(`读不到 package.json 的 version：${e instanceof Error ? e.message : String(e)}`)
}
if (typeof version !== 'string' || version.trim() === '' || version === '0.0.0') {
  fail('package.json 的 version 为空或 0.0.0')
}

if (!existsSync(outDir)) fail('out/ 不存在，先跑 electron-vite build')

for (const rel of REQUIRED_FILES) {
  const file = join(outDir, rel)
  if (!existsSync(file) || !statSync(file).isFile()) fail(`缺少关键文件：${rel}`)
  if (statSync(file).size === 0) fail(`关键文件为空：${rel}`)
}

const files = []

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full)
    else if (entry.isFile()) {
      const rel = relative(outDir, full).split(sep).join('/')
      if (rel !== 'manifest.json') files.push(rel)
    }
  }
}

collect(outDir)
files.sort()

writeFileSync(manifestFile, `${JSON.stringify({ version, files }, null, 2)}\n`, 'utf8')
console.log(`manifest ready: ${version} (${files.length} files)`)
