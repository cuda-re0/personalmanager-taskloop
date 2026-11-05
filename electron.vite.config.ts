import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = { '@shared': resolve('src/shared') }

/**
 * P0 27：同一个源文件不许在产物里出现两次。
 *
 * rollup 以 module id（路径字符串）为唯一键。同一文件若因路径写法差异（盘符大小写、
 * 正/反斜杠、8.3 短名、`..` 未折叠、alias 与相对路径混用等）拿到两个 id，就会被当成
 * 两个模块打进同一份 bundle，模块级单例随之被拆成两份变量：src/main/db/connection.ts
 * 里的 `current` 一份被 initDb() 写、另一份被各 repo 的 getDb() 读，于是生产包里
 * createHudWindow() 先抛「数据库尚未初始化」，同一行后面的 registerIpcHandlers()
 * 永不执行，所有 IPC 变成 No handler registered——而构建一声不吭、照样报成功。
 *
 * 这里在产物阶段按 realpath 归一后校验：一个文件只能对应一个 id。命中即让构建失败，
 * 并把两个 id 原样打出来，下一次复现就能直接看到差异出在哪一段路径上。
 */
function assertSingleModuleInstance(): Plugin {
  return {
    name: 'taskloop:assert-single-module-instance',
    apply: 'build',
    generateBundle() {
      const idByRealPath = new Map<string, string>()
      const collisions: string[] = []
      for (const id of this.getModuleIds()) {
        // 只看落在磁盘上的绝对路径；虚拟模块（\0 前缀）与外部依赖不参与
        if (id.startsWith('\0') || !/^[A-Za-z]:[\\/]/.test(id)) continue
        let real: string
        try {
          real = realpathSync.native(id)
        } catch {
          continue
        }
        const key = real.toLowerCase()
        const first = idByRealPath.get(key)
        if (first === undefined) idByRealPath.set(key, id)
        else if (first !== id) collisions.push(`${real}\n    id1: ${first}\n    id2: ${id}`)
      }
      if (collisions.length > 0) {
        this.error(
          `同一份源码被打成了多份（P0 27）：\n${collisions.join('\n')}\n` +
            '模块级单例会因此被拆开，产物 IPC 全瘫。请把以上 id 原样报给架构方。'
        )
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), assertSingleModuleInstance()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        // 关掉 tree-shake：W1/W2 的空壳 `initDb()` / `registerIpcHandlers()` 函数体为空，
        // 开着 tree-shake 会把调用行整条摇掉，接线点就静默消失了。主进程包体积无所谓。
        treeshake: false,
        // 入口用相对路径（P0 27）：绝对路径会把 cwd 的盘符大小写/分隔符带进 module id，
        // 相对路径统一由 vite 解析成 realpath，不依赖调用方从哪个目录、哪个盘符启动构建。
        input: { index: 'src/main/index.ts' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: sharedAlias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          // 两个独立 HTML 入口：HUD 不与主窗共用文档
          main: resolve('src/renderer/main/index.html'),
          hud: resolve('src/renderer/hud/index.html'),
          // v0.58：提醒窗口（横幅 / 小程序）也是独立文档，不与前两个共用
          notify: resolve('src/renderer/notify/index.html')
        }
      }
    }
  }
})
