/**
 * `.sql?raw` 导入的类型声明。
 * 迁移用 `?raw` 把 SQL 内联进包，避免运行时去 out/ 里找 .sql 文件（electron-vite 不复制非 JS 资源）。
 * vite（含 vitest）原生支持 `?raw`，这里只是给 tsc 补一个模块声明。
 */
declare module '*.sql?raw' {
  const content: string
  export default content
}
