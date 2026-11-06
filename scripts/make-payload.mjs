#!/usr/bin/env node
/**
 * 78 单 · 把 `npm run pack` 的产物打成单个 JSON 载荷，供 GitHub Release 上传。
 *
 * 输入 dist/taskloop/updates/app（out/** + package.json），键统一用正斜杠相对路径，
 * 值是文件内容的 base64。输出 dist/release/payload.json，UTF-8 单行、不做换行美化。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const input = join(root, 'dist', 'taskloop', 'updates', 'app')
const outputDir = join(root, 'dist', 'release')
const output = join(outputDir, 'payload.json')
const pkgFile = join(input, 'package.json')
const outDir = join(input, 'out')

/**
 * 与 `src/main/update/updateService.ts` 的 REQUIRED_FILES 保持同一份清单。
 * 少了任何一个，客户端装完就是白屏，而且版本号已变、不会再自愈重装。
 */
const REQUIRED_FILES = [
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/main/index.html',
  'out/renderer/hud/index.html',
  'out/renderer/notify/index.html'
]

if (!existsSync(input) || !existsSync(outDir) || !existsSync(pkgFile)) {
  console.error('先跑 npm run pack')
  process.exit(1)
}

for (const rel of REQUIRED_FILES) {
  const file = join(input, rel)
  if (!existsSync(file)) {
    console.error(`缺少关键文件：${rel}`)
    process.exit(1)
  }
  if (statSync(file).size === 0) {
    console.error(`关键文件为空：${rel}`)
    process.exit(1)
  }
}

let version = ''
try {
  version = JSON.parse(readFileSync(pkgFile, 'utf8')).version
} catch (e) {
  console.error(`读不到 ${pkgFile} 的 version：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
if (typeof version !== 'string' || version.trim() === '') {
  console.error('package.json 的 version 为空')
  process.exit(1)
}

const files = {}

function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(full)
    else if (entry.isFile()) {
      files[relative(input, full).split(sep).join('/')] = readFileSync(full).toString('base64')
    }
  }
}

collect(outDir)
files['package.json'] = readFileSync(pkgFile).toString('base64')

mkdirSync(outputDir, { recursive: true })
const json = JSON.stringify({ version, files })
writeFileSync(output, json, 'utf8')

console.log(`version: ${version}`)
console.log(`files: ${Object.keys(files).length}`)
console.log(`size: ${Math.round(Buffer.byteLength(json, 'utf8') / 1024)} KB`)
