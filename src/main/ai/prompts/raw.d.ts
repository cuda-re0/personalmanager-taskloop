/**
 * Vite 的 `?raw` 导入类型声明（主进程侧）。
 *
 * prompt 用 `.md` 存（架构方要逐句审），运行时靠 `?raw` 打进 bundle。
 * TS 不认 `x.md?raw` 这种带 query 的模块说明符，所以在这里声明一次。
 */
declare module '*.md?raw' {
  const content: string
  export default content
}
