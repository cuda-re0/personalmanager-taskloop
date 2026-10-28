import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * vitest 的别名表必须与 `electron.vite.config.ts` 的三段保持一致。
 *
 * 为什么非要有这份配置：`src/renderer` 里的模块按 `@shared/*` 引共享层，这个别名只配在
 * electron.vite.config.ts 里，而那是 electron-vite 的入口，vitest 不读它。少了这份配置，
 * 任何经由渲染层模块的测试都会 `Failed to load url @shared/...`——注意问题不在测试文件
 * 自己的导入上（那几条都是相对路径），而是**被测模块内部**的别名解析不了。
 *
 * 环境固定 node，不开 jsdom：现有用例都是纯函数，没有渲染 DOM。以后真要测组件再给那几个
 * 文件单独开 environment，别把所有测试拖进 jsdom（慢一个数量级）。
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared') }
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node'
  }
})
