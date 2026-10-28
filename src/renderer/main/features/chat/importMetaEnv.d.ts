/**
 * tsconfig.web.json 的 `types` 为空（不引 vite/client），而渲染层要用 import.meta.env。
 * 这里只声明用得到的字段，够 W3 用；W2 接后端时可整体换成 `/// <reference types="vite/client" />`。
 */
interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
