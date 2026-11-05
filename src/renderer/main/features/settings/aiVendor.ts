/**
 * AI 接口供应商预设（v0.76）。
 *
 * 只放常量与纯判定，不依赖 electron / IPC / React：设置页与主进程都只认
 * `ai.baseUrl` 加两个模型名，本文件负责把「选哪家」翻译回这三项草稿值。
 */

export type AiVendor = 'zhipu' | 'deepseek'

export interface AiVendorPreset {
  task: string
  chat: string
  baseUrl: string
}

/** 数组定顺序：设置页直接遍历它，别处不再抄第二份列表 */
export const AI_VENDORS: AiVendor[] = ['zhipu', 'deepseek']

export const AI_VENDOR_PRESETS: Record<AiVendor, AiVendorPreset> = {
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    task: 'glm-5.3-flash',
    chat: 'glm-4.7-flashx'
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    task: 'deepseek-flash',
    chat: 'deepseek-flash'
  }
}

/**
 * 只用来画按钮高亮，不参与请求。子串匹配而非 new URL()：用户可能填半截地址，
 * 解析抛错会让整个抽屉挂掉；这里判错最多是按钮不亮。
 */
export function vendorOf(baseUrl: string): AiVendor | null {
  const s = baseUrl.trim().toLowerCase().replace(/\/+$/, '')
  if (s === '') return null
  if (s.includes('open.bigmodel.cn')) return 'zhipu'
  if (s.includes('api.deepseek.com')) return 'deepseek'
  return null
}
