import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        // 关掉 tree-shake：W1/W2 的空壳 `initDb()` / `registerIpcHandlers()` 函数体为空，
        // 开着 tree-shake 会把调用行整条摇掉，接线点就静默消失了。主进程包体积无所谓。
        treeshake: false,
        input: { index: resolve('src/main/index.ts') }
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
          hud: resolve('src/renderer/hud/index.html')
        }
      }
    }
  }
})
